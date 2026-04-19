  ;; ============================================================
  ;; WIN32 API HANDLER FUNCTIONS
  ;; Hand-written implementations called from the generated dispatch.
  ;; Each handler receives (arg0..arg4, name_ptr) and must set $eax
  ;; and adjust $esp for stdcall cleanup before returning.
  ;; ============================================================

  ;; ---- Timer table helpers ----
  ;; Timer table at 0x24C0: 16 entries × 20 bytes
  ;; Each entry: [hwnd:4][id:4][interval:4][last_tick:4][callback:4]
  ;; id=0 means slot is empty

  ;; $timer_set(hwnd, id, interval_ms, callback) — add or update a timer
  (func $timer_set (param $hwnd i32) (param $id i32) (param $interval i32) (param $callback i32)
    (local $i i32)
    (local $addr i32)
    (local $free_slot i32)
    (local.set $free_slot (i32.const -1))
    (local.set $i (i32.const 0))
    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (global.get $TIMER_MAX)))
        (local.set $addr (i32.add (global.get $TIMER_TABLE) (i32.mul (local.get $i) (global.get $TIMER_ENTRY_SIZE))))
        ;; Check if this slot matches (same hwnd + id) — update in place
        (if (i32.and
              (i32.eq (i32.load (local.get $addr)) (local.get $hwnd))
              (i32.eq (i32.load (i32.add (local.get $addr) (i32.const 4))) (local.get $id)))
          (then
            (i32.store (i32.add (local.get $addr) (i32.const 8)) (local.get $interval))
            (i32.store (i32.add (local.get $addr) (i32.const 12)) (global.get $tick_count))
            (i32.store (i32.add (local.get $addr) (i32.const 16)) (local.get $callback))
            (return)
          )
        )
        ;; Track first free slot (hwnd=0 means empty)
        (if (i32.and
              (i32.eq (local.get $free_slot) (i32.const -1))
              (i32.eqz (i32.load (local.get $addr))))
          (then (local.set $free_slot (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
    ;; Not found — insert into free slot
    (if (i32.ge_s (local.get $free_slot) (i32.const 0))
      (then
        (local.set $addr (i32.add (global.get $TIMER_TABLE) (i32.mul (local.get $free_slot) (global.get $TIMER_ENTRY_SIZE))))
        (i32.store (local.get $addr) (local.get $hwnd))
        (i32.store (i32.add (local.get $addr) (i32.const 4)) (local.get $id))
        (i32.store (i32.add (local.get $addr) (i32.const 8)) (local.get $interval))
        (i32.store (i32.add (local.get $addr) (i32.const 12)) (global.get $tick_count))
        (i32.store (i32.add (local.get $addr) (i32.const 16)) (local.get $callback))
        (global.set $timer_count (i32.add (global.get $timer_count) (i32.const 1)))
      )
    )
  )

  ;; $timer_kill(hwnd, id) — remove a timer, return 1 if found
  (func $timer_kill (param $hwnd i32) (param $id i32) (result i32)
    (local $i i32)
    (local $addr i32)
    (local.set $i (i32.const 0))
    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (global.get $TIMER_MAX)))
        (local.set $addr (i32.add (global.get $TIMER_TABLE) (i32.mul (local.get $i) (global.get $TIMER_ENTRY_SIZE))))
        (if (i32.and
              (i32.eq (i32.load (local.get $addr)) (local.get $hwnd))
              (i32.eq (i32.load (i32.add (local.get $addr) (i32.const 4))) (local.get $id)))
          (then
            ;; Clear the slot (set hwnd=0)
            (i32.store (local.get $addr) (i32.const 0))
            (global.set $timer_count (i32.sub (global.get $timer_count) (i32.const 1)))
            (return (i32.const 1))
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
    (i32.const 0)
  )

  ;; $timer_check_due(msg_ptr, consume) — scan timer table, fill MSG with first due timer, return 1 if found
  ;; $consume: 1 = update last_tick (PM_REMOVE/GetMessage), 0 = peek only (PM_NOREMOVE)
  (func $timer_check_due (param $msg_ptr i32) (param $consume i32) (result i32)
    (local $i i32)
    (local $addr i32)
    (local $elapsed i32)
    ;; Update tick_count from host real time
    (global.set $tick_count (call $host_get_ticks))
    (local.set $i (i32.const 0))
    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (global.get $TIMER_MAX)))
        (local.set $addr (i32.add (global.get $TIMER_TABLE) (i32.mul (local.get $i) (global.get $TIMER_ENTRY_SIZE))))
        ;; Skip empty slots (hwnd=0 means empty)
        (if (i32.load (local.get $addr))
          (then
            (local.set $elapsed (i32.sub (global.get $tick_count) (i32.load (i32.add (local.get $addr) (i32.const 12)))))
            (if (i32.ge_u (local.get $elapsed) (i32.load (i32.add (local.get $addr) (i32.const 8))))
              (then
                ;; Timer is due — only update last_tick if consuming
                (if (local.get $consume)
                  (then (i32.store (i32.add (local.get $addr) (i32.const 12)) (global.get $tick_count))))
                (call $gs32 (local.get $msg_ptr) (i32.load (local.get $addr)))                          ;; hwnd
                (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0113))            ;; WM_TIMER
                (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.load (i32.add (local.get $addr) (i32.const 4))))   ;; wParam=timerID
                (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.load (i32.add (local.get $addr) (i32.const 16)))) ;; lParam=callback
                (return (i32.const 1))
              )
            )
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
    ;; Check multimedia timer (timeSetEvent)
    (if (global.get $mm_timer_id)
      (then
        (local.set $elapsed (i32.sub (global.get $tick_count) (global.get $mm_timer_last_tick)))
        (if (i32.ge_u (local.get $elapsed) (global.get $mm_timer_interval))
          (then
            (if (local.get $consume)
              (then
                (global.set $mm_timer_last_tick (global.get $tick_count))
                (if (global.get $mm_timer_oneshot)
                  (then (global.set $mm_timer_id (i32.const 0))))))
            (call $gs32 (local.get $msg_ptr) (i32.const 0))                                        ;; hwnd=0
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x7FF0))           ;; internal MM_TIMER
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (global.get $mm_timer_id))    ;; wParam=timerID
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $mm_timer_callback)) ;; lParam=callback
            (return (i32.const 1))))))
    (i32.const 0)
  )

  ;; Post queue dequeue — reads one i32 at a time from queue at 0x400
  ;; Call 4 times to get hwnd, msg, wParam, lParam; auto-shifts on 4th read
  (func $post_queue_dequeue (result i32)
    (local $val i32)
    (local.set $val (i32.load (i32.add (i32.const 0x400) (global.get $pq_read_off))))
    (global.set $pq_read_off (i32.add (global.get $pq_read_off) (i32.const 4)))
    (if (i32.ge_u (global.get $pq_read_off) (i32.const 16))
      (then
        (global.set $pq_read_off (i32.const 0))
        (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
        (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
          (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
            (i32.mul (global.get $post_queue_count) (i32.const 16)))))))
    (local.get $val)
  )

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
    (local $tmp i32) (local $v i32) (local $i i32) (local $dll_base i32) (local $resolved i32)
    (block $gpa
    ;; Default return value: NULL (function not found)
    (global.set $eax (i32.const 0))
    ;; If lpProcName is an ordinal (< 0x10000), return 0 (unsupported)
    (br_if $gpa (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
    ;; Check if hModule matches a loaded DLL — if so, resolve from its export table
    (local.set $i (i32.const 0))
    (block $not_dll (loop $scan_dll
      (br_if $not_dll (i32.ge_u (local.get $i) (global.get $dll_count)))
      (local.set $dll_base (i32.load (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $i) (i32.const 32)))))
      (if (i32.eq (local.get $dll_base) (local.get $arg0))
        (then
          ;; Found matching DLL — resolve export by name
          (local.set $resolved (call $resolve_name_export (local.get $i) (call $g2w (local.get $arg1))))
          (if (local.get $resolved)
            (then
              (global.set $eax (local.get $resolved))
              (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
              (return)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan_dll)))
    ;; Not a loaded DLL — create thunk as before (Win32 API)
    ;; Allocate hint(2) + name in guest heap
    (local.set $tmp (call $guest_strlen (local.get $arg1)))
    (local.set $v (call $heap_alloc (i32.add (local.get $tmp) (i32.const 3)))) ;; 2 hint + name + NUL
    ;; Write hint = 0
    (i32.store16 (call $g2w (local.get $v)) (i32.const 0))
    ;; Copy name string
    (call $memcpy (i32.add (call $g2w (local.get $v)) (i32.const 2))
    (call $g2w (local.get $arg1)) (i32.add (local.get $tmp) (i32.const 1)))
    ;; Look up api_id — if unknown (0xFFFF), return NULL instead of creating broken thunk
    (local.set $i (call $lookup_api_id (i32.add (call $g2w (local.get $v)) (i32.const 2))))
    (if (i32.eq (local.get $i) (i32.const 0xFFFF))
      (then (br $gpa))) ;; return 0 — function not found
    ;; Create thunk: store RVA and api_id at THUNK_BASE + num_thunks*8
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
    (i32.sub (local.get $v) (global.get $image_base)))
    ;; Store api_id
    (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
    (local.get $i))
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

  ;; 6: GetLocalTime(lpSystemTime) — fills SYSTEMTIME with simulated time
  (func $handle_GetLocalTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $secs i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $secs (i32.div_u (call $host_get_ticks) (i32.const 1000)))
    (i32.store16 (local.get $wa) (i32.const 2000))
    (i32.store16 (i32.add (local.get $wa) (i32.const 2)) (i32.const 1))
    (i32.store16 (i32.add (local.get $wa) (i32.const 4)) (i32.const 6))
    (i32.store16 (i32.add (local.get $wa) (i32.const 6)) (i32.const 1))
    (i32.store16 (i32.add (local.get $wa) (i32.const 8))
      (i32.rem_u (i32.div_u (local.get $secs) (i32.const 3600)) (i32.const 24)))
    (i32.store16 (i32.add (local.get $wa) (i32.const 10))
      (i32.rem_u (i32.div_u (local.get $secs) (i32.const 60)) (i32.const 60)))
    (i32.store16 (i32.add (local.get $wa) (i32.const 12))
      (i32.rem_u (local.get $secs) (i32.const 60)))
    (i32.store16 (i32.add (local.get $wa) (i32.const 14))
      (i32.rem_u (call $host_get_ticks) (i32.const 1000)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 7: GetTimeFormatA(Locale, dwFlags, lpTime, lpFormat, lpTimeStr, cchTime) — 6 args stdcall
  (func $handle_GetTimeFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $buf i32) (local $cch i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $cch (call $gl32 (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $buf (call $g2w (local.get $arg4)))
    (if (i32.and (i32.ne (local.get $arg4) (i32.const 0)) (i32.ge_u (local.get $cch) (i32.const 9)))
      (then
        ;; Write "12:00 AM\0"
        (i32.store8 (local.get $buf) (i32.const 49))          ;; '1'
        (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 50))  ;; '2'
        (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 58))  ;; ':'
        (i32.store8 (i32.add (local.get $buf) (i32.const 3)) (i32.const 48))  ;; '0'
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 48))  ;; '0'
        (i32.store8 (i32.add (local.get $buf) (i32.const 5)) (i32.const 32))  ;; ' '
        (i32.store8 (i32.add (local.get $buf) (i32.const 6)) (i32.const 65))  ;; 'A'
        (i32.store8 (i32.add (local.get $buf) (i32.const 7)) (i32.const 77))  ;; 'M'
        (i32.store8 (i32.add (local.get $buf) (i32.const 8)) (i32.const 0))   ;; NUL
        (global.set $eax (i32.const 9))
      )
      (else
        (global.set $eax (i32.const 9))
      ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args + ret
  )

  ;; 8: GetDateFormatA(Locale, dwFlags, lpDate, lpFormat, lpDateStr, cchDateStr) — 6 args stdcall
  (func $handle_GetDateFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $buf i32) (local $len i32) (local $cch i32)
    ;; Read cchDateStr from stack (6th arg at esp+24)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $cch (call $gl32 (i32.add (local.get $wa_esp) (i32.const 24))))
    ;; If lpDate (arg2) is NULL, use current date; if lpFormat (arg3) is NULL, use default
    ;; Simple implementation: write "1/1/01" as a short date
    (local.set $buf (call $g2w (local.get $arg4)))
    (if (i32.and (i32.ne (local.get $arg4) (i32.const 0)) (i32.ge_u (local.get $cch) (i32.const 7)))
      (then
        ;; Write "1/1/01\0"
        (i32.store8 (local.get $buf) (i32.const 49))          ;; '1'
        (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 47))  ;; '/'
        (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 49))  ;; '1'
        (i32.store8 (i32.add (local.get $buf) (i32.const 3)) (i32.const 47))  ;; '/'
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 48))  ;; '0'
        (i32.store8 (i32.add (local.get $buf) (i32.const 5)) (i32.const 49))  ;; '1'
        (i32.store8 (i32.add (local.get $buf) (i32.const 6)) (i32.const 0))   ;; NUL
        (global.set $eax (i32.const 7))  ;; chars written including NUL
      )
      (else
        ;; Buffer too small or NULL — return required size
        (global.set $eax (i32.const 7))
      ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args + ret
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

  ;; SetLocaleInfoA(Locale, LCType, lpLCData) — accept & drop. Apps persist user prefs here; we don't store them but must return nonzero so callers proceed.
  (func $handle_SetLocaleInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; SetThreadLocale(Locale) → BOOL. We don't track thread locales; accept and return TRUE.
  (func $handle_SetThreadLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 12: LoadLibraryA
  (func $handle_LoadLibraryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $src i32) (local $dst i32) (local $ch i32)
    (local.set $tmp (call $find_loaded_dll (local.get $arg0)))
    (if (i32.ge_s (local.get $tmp) (i32.const 0))
      (then
        (global.set $eax (i32.load (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $tmp) (i32.const 32)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Not already loaded — check if DLL file exists in VFS
    (if (call $host_has_dll_file (call $g2w (local.get $arg0)))
      (then
        ;; DLL file found — yield to JS for loading
        (global.set $loadlib_name_ptr (call $g2w (local.get $arg0)))
        (global.set $eip (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (global.set $yield_reason (i32.const 5))
        (global.set $yield_flag (i32.const 1))
        (global.set $steps (i32.const 0))
        (return)))
    ;; Not found — return EXE base (system DLL stub) so GetProcAddress can create thunks
    (global.set $eax (global.get $image_base))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
    ;; _lopen(lpPathName, iReadWrite) — 2 args stdcall
    (global.set $eax (call $host_fs_create_file
      (call $g2w (local.get $arg0))
      (i32.const 0x80000000)  ;; GENERIC_READ
      (i32.const 3)           ;; OPEN_EXISTING
      (i32.const 0x80)        ;; FILE_ATTRIBUTE_NORMAL
      (i32.const 0)))         ;; isWide=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args + ret
  )

  ;; 21: _lwrite — STUB: unimplemented
  (func $handle__lwrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 22: _llseek — STUB: unimplemented
  (func $handle__llseek (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; _llseek(hFile, lOffset, iOrigin) — 3 args stdcall
    (global.set $eax (call $host_fs_set_file_pointer
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args + ret
  )

  ;; 23: _lclose — STUB: unimplemented
  (func $handle__lclose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; _lclose(hFile) — 1 arg stdcall
    (drop (call $host_fs_close_handle (local.get $arg0)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg + ret
  )

  ;; 24: _lread — STUB: unimplemented
  (func $handle__lread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; _lread(hFile, lpBuffer, uBytes) — 3 args stdcall
    ;; host_fs_read_file(handle, bufferWA, nBytes, lpBytesRead_WA) -> bool
    ;; We use a scratch area on the stack for bytesRead
    (local $bytes_read_ga i32) (local $bytes_read_wa i32)
    (local.set $bytes_read_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_read_wa (call $g2w (local.get $bytes_read_ga)))
    (i32.store (local.get $bytes_read_wa) (i32.const 0))
    (drop (call $host_fs_read_file
      (local.get $arg0)
      (local.get $arg1)
      (local.get $arg2)
      (local.get $bytes_read_ga)))
    (global.set $eax (i32.load (local.get $bytes_read_wa)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args + ret
  )

  ;; 938: _hread — identical to _lread
  (func $handle__hread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $bytes_read_ga i32) (local $bytes_read_wa i32)
    (local.set $bytes_read_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_read_wa (call $g2w (local.get $bytes_read_ga)))
    (i32.store (local.get $bytes_read_wa) (i32.const 0))
    (drop (call $host_fs_read_file
      (local.get $arg0)
      (local.get $arg1)
      (local.get $arg2)
      (local.get $bytes_read_ga)))
    (global.set $eax (i32.load (local.get $bytes_read_wa)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 25: Sleep — STUB: unimplemented
  (func $handle_Sleep (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Sleep(dwMilliseconds) — 1 arg stdcall.
    ;; Always yield so other threads get execution time.
    ;; Sleep(0) only sets yield_flag (not sleep_yielded) — it won't deprioritize.
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (global.set $yield_flag (i32.const 1))
    (if (local.get $arg0)
      (then (global.set $sleep_yielded (i32.const 1))))
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

  ;; 33: HeapCreate(flOptions, dwInitialSize, dwMaximumSize) — 3 args stdcall
  (func $handle_HeapCreate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00140000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 34: HeapDestroy(hHeap) → BOOL. We use a single shared heap; pretend success.
  (func $handle_HeapDestroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 35: HeapAlloc
  (func $handle_HeapAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_alloc (local.get $arg2)))
    ;; Zero memory if HEAP_ZERO_MEMORY (0x08) — skip on OOM (eax=0)
    (if (i32.and (i32.ne (global.get $eax) (i32.const 0))
                 (i32.ne (i32.and (local.get $arg1) (i32.const 0x08)) (i32.const 0)))
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

  ;; 38: VirtualAlloc(lpAddr, dwSize, flAllocType, flProtect)
  ;; Must return page-aligned (0x1000) addresses for reserve/commit
  (func $handle_VirtualAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $size i32)
    (if (local.get $arg0)
      (then (global.set $eax (local.get $arg0))) ;; MEM_COMMIT at addr, just return it
      (else
        ;; Round size up to page boundary
        (local.set $size (i32.and (i32.add (local.get $arg1) (i32.const 0xFFF)) (i32.const 0xFFFFF000)))
        ;; Align heap_ptr up to page boundary before allocating
        (global.set $heap_ptr (i32.and (i32.add (global.get $heap_ptr) (i32.const 0xFFF)) (i32.const 0xFFFFF000)))
        ;; Bump-allocate page-aligned region (no header, VirtualAlloc memory not freed via HeapFree)
        (global.set $eax (global.get $heap_ptr))
        (global.set $heap_ptr (i32.add (global.get $heap_ptr) (local.get $size)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 39: VirtualFree — return TRUE (no real decommit needed)
  (func $handle_VirtualFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 40: GetACP — STUB: unimplemented
  (func $handle_GetACP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1252))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 791: GetUserDefaultLangID() → LANGID (0x0409 = English US)
  (func $handle_GetUserDefaultLangID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0409))
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

  ;; 45: GetStringTypeA(Locale, dwInfoType, lpSrcStr, cchSrc, lpCharType) — single-byte CT_CTYPE1 classification.
  (func $handle_GetStringTypeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $ch i32) (local $ct i32) (local $out i32) (local $src i32) (local $count i32)
    (local.set $src (call $g2w (local.get $arg2)))
    (local.set $out (call $g2w (local.get $arg4)))
    (local.set $count (local.get $arg3))
    (if (i32.eq (local.get $count) (i32.const -1))
      (then (local.set $count (i32.add (call $strlen_a (local.get $src)) (i32.const 1)))))
    (local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (local.set $ct (i32.const 0))
      (if (i32.le_u (local.get $ch) (i32.const 31))
        (then (local.set $ct (i32.const 0x20))))
      (if (i32.or (i32.eq (local.get $ch) (i32.const 32))
            (i32.or (i32.eq (local.get $ch) (i32.const 9))
              (i32.or (i32.eq (local.get $ch) (i32.const 10)) (i32.eq (local.get $ch) (i32.const 13)))))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x08)))))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 48)) (i32.le_u (local.get $ch) (i32.const 57)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x04)))))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 65)) (i32.le_u (local.get $ch) (i32.const 90)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x101)))))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 97)) (i32.le_u (local.get $ch) (i32.const 122)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x102)))))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 33)) (i32.le_u (local.get $ch) (i32.const 47)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x10)))))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 58)) (i32.le_u (local.get $ch) (i32.const 64)))
        (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x10)))))
      (i32.store16 (i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 2))) (local.get $ct))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
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
    (if (i32.and (i32.ne (local.get $arg4) (i32.const 0)) (i32.ne (local.get $cchDest) (i32.const 0)))
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
    (if (i32.and (i32.ne (local.get $arg4) (i32.const 0)) (i32.ne (local.get $cchDest) (i32.const 0)))
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

  ;; 50: GetFileType(hFile) — FILE_TYPE_CHAR=2 for console, FILE_TYPE_DISK=1 for files
  (func $handle_GetFileType (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (i32.le_u (local.get $arg0) (i32.const 3))
        (then (i32.const 2))   ;; FILE_TYPE_CHAR (console)
        (else (i32.const 1)))) ;; FILE_TYPE_DISK (regular file)
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
    (local $dst i32) (local $i i32) (local $len i32)
    ;; Write "C:\<exe_name>" to buffer
    (local.set $dst (call $g2w (local.get $arg1)))
    (i32.store8 (local.get $dst) (i32.const 0x43))  ;; 'C'
    (i32.store8 (i32.add (local.get $dst) (i32.const 1)) (i32.const 0x3A))  ;; ':'
    (i32.store8 (i32.add (local.get $dst) (i32.const 2)) (i32.const 0x5C))  ;; '\'
    ;; Copy exe name
    (local.set $len (global.get $exe_name_len))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $i) (i32.const 3)))
        (i32.load8_u (i32.add (global.get $exe_name_wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (local.get $dst) (i32.add (local.get $len) (i32.const 3))) (i32.const 0))
    (global.set $eax (i32.add (local.get $len) (i32.const 3)))
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
    (global.set $tick_count (call $host_get_ticks))
    (global.set $eax (global.get $tick_count))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 59: FindResourceA
  (func $handle_FindResourceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FindResourceA(hModule, lpName, lpType) → HRSRC (RVA of data entry)
    ;; arg0=hModule, arg1=lpName (MAKEINTRESOURCE or string), arg2=lpType
    ;; Walk resource directory: type(arg2) → name(arg1) → first lang → data entry RVA
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax (call $find_resource (local.get $arg2) (local.get $arg1)))
    (call $pop_rsrc_ctx)
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

  ;; 62: FreeResource(hResData) → BOOL
  ;; On Win32, resources are mapped from the PE image and don't need freeing. Returns FALSE (0).
  (func $handle_FreeResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

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
    ;; FreeLibrary returns TRUE on success (first call), FALSE if already freed
    ;; This handles the NSIS pattern: while(FreeLibrary(h)) {}
    (if (i32.eq (local.get $arg0) (global.get $freelib_last_handle))
      (then
        ;; Same handle freed again — already unloaded, return FALSE
        (global.set $eax (i32.const 0)))
      (else
        ;; First free of this handle — succeed and remember it
        (global.set $freelib_last_handle (local.get $arg0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 65: sndPlaySoundA(pszSound, fuSound) — no-op (no audio support)
  (func $handle_sndPlaySoundA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 863: PlaySoundW(pszSound, hmod, fdwSound) — 3 args stdcall
  ;; SND_RESOURCE=0x40004: pszSound is MAKEINTRESOURCE(id), find WAVE resource and play it
  ;; SND_PURGE=0x40: stop playing, return TRUE
  (func $handle_PlaySoundW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $flags i32) (local $name_id i32) (local $hrsrc i32)
    (local $data_entry_wa i32) (local $data_rva i32) (local $data_size i32) (local $data_wa i32)
    (local.set $flags (local.get $arg2))
    (local.set $name_id (local.get $arg0))
    ;; If pszSound is NULL or SND_PURGE, just return TRUE (stop sound)
    (if (i32.or (i32.eqz (local.get $name_id))
                (i32.and (local.get $flags) (i32.const 0x40)))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; Only handle SND_RESOURCE (0x40004) — find WAVE resource by integer ID
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x40000)))
      (then
        ;; Not a resource — just return TRUE (no file/alias support)
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; Find WAVE resource: walk type entries looking for named "WAVE"
    (if (i32.eqz (global.get $rsrc_rva))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; Find WAVE type entry (named type, need to match "WAVE" string)
    (local.set $hrsrc (call $find_resource_named_type (local.get $name_id)))
    (if (i32.eqz (local.get $hrsrc))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; hrsrc points to data entry (RVA, Size at rsrc_rva-relative offset)
    ;; Read data RVA and size from the resource data entry
    (local.set $data_entry_wa (call $g2w (i32.add (global.get $image_base) (local.get $hrsrc))))
    (local.set $data_rva (i32.load (local.get $data_entry_wa)))
    (local.set $data_size (i32.load (i32.add (local.get $data_entry_wa) (i32.const 4))))
    (if (i32.eqz (local.get $data_size))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; Convert data RVA to WASM address and call host
    (local.set $data_wa (call $g2w (i32.add (global.get $image_base) (local.get $data_rva))))
    (call $host_play_sound (local.get $data_wa) (local.get $data_size))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; PlaySoundA(pszSound, hmod, fdwSound) — 3 args stdcall. Shares logic with PlaySoundW:
  ;; for SND_RESOURCE the pszSound is MAKEINTRESOURCE(id) which is format-independent; for
  ;; file/alias strings we don't support audio playback, so just return TRUE.
  (func $handle_PlaySoundA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $flags i32) (local $name_id i32) (local $hrsrc i32)
    (local $data_entry_wa i32) (local $data_rva i32) (local $data_size i32) (local $data_wa i32)
    (local.set $flags (local.get $arg2))
    (local.set $name_id (local.get $arg0))
    (if (i32.or (i32.eqz (local.get $name_id))
                (i32.and (local.get $flags) (i32.const 0x40)))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x40000)))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eqz (global.get $rsrc_rva))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $hrsrc (call $find_resource_named_type (local.get $name_id)))
    (if (i32.eqz (local.get $hrsrc))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $data_entry_wa (call $g2w (i32.add (global.get $image_base) (local.get $hrsrc))))
    (local.set $data_rva (i32.load (local.get $data_entry_wa)))
    (local.set $data_size (i32.load (i32.add (local.get $data_entry_wa) (i32.const 4))))
    (if (i32.eqz (local.get $data_size))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (local.set $data_wa (call $g2w (i32.add (global.get $image_base) (local.get $data_rva))))
    (call $host_play_sound (local.get $data_wa) (local.get $data_size))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 66: RegisterWindowMessageA(lpString) — return unique msg ID from 0xC000+ range
  (func $handle_RegisterWindowMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $clipboard_format_counter (i32.add (global.get $clipboard_format_counter) (i32.const 1)))
    (global.set $eax (global.get $clipboard_format_counter))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )


  ;; 83: DestroyWindow
  (func $handle_DestroyWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $focus_lost i32) (local $wndproc i32) (local $ret_addr i32)
    ;; If the destroyed window held focus, clear focus_hwnd. After main_hwnd
    ;; promotion below, we'll transfer focus to the (possibly new) main_hwnd.
    (if (i32.eq (local.get $arg0) (global.get $focus_hwnd))
    (then (global.set $focus_hwnd (i32.const 0))
      (local.set $focus_lost (i32.const 1))))
    ;; When destroying main_hwnd, promote to next window only if it's a sibling
    ;; top-level window — NOT a child of the destroyed window.
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
    (then
      (if (i32.and
            (i32.ne (call $wnd_table_get (i32.add (global.get $main_hwnd) (i32.const 1))) (i32.const 0))
            (i32.ne (call $wnd_get_parent (i32.add (global.get $main_hwnd) (i32.const 1)))
                    (global.get $main_hwnd)))
        (then (global.set $main_hwnd (i32.add (global.get $main_hwnd) (i32.const 1))))
        (else (global.set $quit_flag (i32.const 1))))))
    ;; Dialog window destruction sets quit (CreateDialogParamA clears it on recreation)
    (if (i32.eq (local.get $arg0) (global.get $dlg_hwnd))
    (then (global.set $quit_flag (i32.const 1))))
    ;; Recursively destroy window and all its children (frees table slots)
    (call $wnd_destroy_recursive (local.get $arg0))
    ;; Transfer focus to main_hwnd: deliver WM_SETFOCUS synchronously via EIP redirect.
    ;; On real Windows, destroying the focused window gives focus to the next foreground window.
    ;; Only if main_hwnd is valid and different from the destroyed window (may have been promoted).
    (if (i32.and (local.get $focus_lost)
                 (i32.and (i32.ne (global.get $main_hwnd) (i32.const 0))
                          (i32.ne (global.get $main_hwnd) (local.get $arg0))))
      (then
        (local.set $wndproc (call $wnd_table_get (global.get $main_hwnd)))
        (if (i32.eqz (local.get $wndproc))
          (then (local.set $wndproc (global.get $wndproc_addr))))
        (if (i32.and (i32.ne (local.get $wndproc) (i32.const 0))
                     (i32.lt_u (local.get $wndproc) (i32.const 0xFFFF0000)))
          (then
            (global.set $focus_hwnd (global.get $main_hwnd))
            (local.set $ret_addr (call $gl32 (global.get $esp)))
            ;; DestroyWindow stdcall(1): [ret, hwnd] = 8 bytes.
            ;; WndProc stdcall(4): [ret, hwnd, msg, wParam, lParam] = 20 bytes.
            (global.set $esp (i32.sub (global.get $esp) (i32.const 12)))
            (call $gs32 (global.get $esp) (local.get $ret_addr))
            (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (global.get $main_hwnd))
            (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.const 0x0007))  ;; WM_SETFOCUS
            (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (i32.const 0))      ;; wParam = 0
            (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (i32.const 0))      ;; lParam = 0
            (global.set $eip (local.get $wndproc))
            (global.set $eax (i32.const 1))
            (global.set $steps (i32.const 0))
            (return)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 84: DestroyMenu(hMenu) — 1 arg stdcall, return TRUE
  (func $handle_DestroyMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 88: GetSubMenu(hMenu, nPos) → HMENU
  ;; Returns submenu handle at position nPos. Encode as hMenu | (pos << 16).
  (func $handle_GetSubMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.or
      (i32.and (local.get $arg0) (i32.const 0xFFFF))
      (i32.shl (i32.add (local.get $arg1) (i32.const 1)) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 314: GetSystemMenu(hwnd, bRevert) — stdcall(2)
  (func $handle_GetSystemMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x40003))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
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

  ;; 1099: EnumDisplayMonitors(hdc, lprcClip, lpfnEnum, dwData) — 4 args stdcall
  ;; Calls lpfnEnum(hMonitor, hdcMonitor, lprcMonitor, dwData) once for primary monitor
  (func $handle_EnumDisplayMonitors (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32) (local $callback i32) (local $data i32) (local $rect_guest i32)
    ;; arg2 = lpfnEnum (callback), arg3 = dwData
    (local.set $callback (local.get $arg2))
    (local.set $data (local.get $arg3))
    ;; If no callback, just return TRUE
    (if (i32.eqz (local.get $callback))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; Save original return address
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Pop EnumDisplayMonitors frame: ret + 4 args = 20 bytes
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    ;; Allocate RECT {0, 0, 640, 480} on stack (16 bytes)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 16)))
    (local.set $rect_guest (i32.add (i32.sub (global.get $esp) (i32.const 0x12000)) (global.get $image_base)))
    (call $gs32 (global.get $esp) (i32.const 0))         ;; left
    (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (i32.const 0))   ;; top
    (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.const 640)) ;; right
    (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (i32.const 480)) ;; bottom
    ;; Push callback args right-to-left: dwData, lprcMonitor, hdcMonitor, hMonitor
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $data))          ;; dwData
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $rect_guest))    ;; lprcMonitor (guest addr)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))              ;; hdcMonitor = NULL
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x00010001))     ;; hMonitor (fake handle)
    ;; Push return address — callback is stdcall so it pops its own 16 bytes
    ;; After callback returns, RECT (16 bytes on stack) remains — but caller's ESP is restored
    ;; Actually the RECT sits below the callback frame, need to adjust:
    ;; When callback returns (stdcall pops 16 bytes), ESP points to RECT.
    ;; We need the original ret_addr AFTER the RECT is cleaned up.
    ;; Solution: put a thunk return address that cleans up the RECT and returns.
    ;; Simpler: just put the RECT in scratch memory instead of on the stack.
    ;; Let's use WASM address 0xAD00 area which is below GUEST_BASE.
    ;; Actually — store RECT at a fixed known location in the sub-GUEST_BASE region.
    ;; Reset: undo stack RECT, use fixed scratch instead.
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))) ;; undo the 4 pushes + RECT
    ;; Write RECT at WASM addr 0xAD40 (unused scratch below GUEST_BASE)
    (i32.store (i32.const 0xAD40) (i32.const 0))       ;; left
    (i32.store (i32.const 0xAD44) (i32.const 0))       ;; top
    (i32.store (i32.const 0xAD48) (i32.const 640))     ;; right
    (i32.store (i32.const 0xAD4C) (i32.const 480))     ;; bottom
    ;; Guest address for 0xAD40: image_base + (0xAD40 - 0x12000) = image_base - 0x72C0
    ;; Actually RECT needs to be at a guest-addressable address. g2w = guest - image_base + GUEST_BASE
    ;; So guest = wasm - GUEST_BASE + image_base = 0xAD40 - 0x12000 + image_base
    ;; If image_base=0x400000 -> guest = 0x3F8D40, which is below image_base but above 0.
    ;; The callback reads RECT via the pointer — so it will do g2w(guest) and get 0xAD40. Should work.
    (local.set $rect_guest (i32.add (i32.sub (i32.const 0xAD40) (i32.const 0x12000)) (global.get $image_base)))
    ;; Push callback args right-to-left
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $data))          ;; dwData
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $rect_guest))    ;; lprcMonitor
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))              ;; hdcMonitor
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x00010001))     ;; hMonitor
    ;; Push return address — when stdcall callback pops 16 bytes and rets, goes to ret_addr
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Jump to callback
    (global.set $eip (local.get $callback))
    (global.set $steps (i32.const 0))
  )

  ;; 91: GetClientRect
  (func $handle_GetClientRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32)
    ;; Controls live entirely in WAT (CONTROL_GEOM) — asking the host for
    ;; their client size falls back to the 640×480 desktop default because
    ;; child hwnds aren't in renderer.windows[], which then corrupts any
    ;; size calc the guest does from it (calc's dialog resize is one such
    ;; path). For controls, read the size directly from CONTROL_GEOM.
    (if (call $ctrl_table_get_class (local.get $arg0))
      (then (local.set $cs (call $ctrl_get_wh_packed (local.get $arg0))))
      (else (local.set $cs (call $host_get_window_client_size (local.get $arg0)))))
    (call $gs32 (local.get $arg1) (i32.const 0))       ;; left
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))   ;; top
    (call $gs32 (i32.add (local.get $arg1) (i32.const 8))
      (i32.and (local.get $cs) (i32.const 0xFFFF)))     ;; right = clientW
    (call $gs32 (i32.add (local.get $arg1) (i32.const 12))
      (i32.shr_u (local.get $cs) (i32.const 16)))       ;; bottom = clientH
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 92: GetWindowTextA(hwnd, lpString, nMaxCount) → int
  (func $handle_GetWindowTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_get_window_text
      (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 93: GetWindowRect
  (func $handle_GetWindowRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetWindowRect(hwnd, lpRect) — fills RECT with screen coords
    (call $host_get_window_rect (local.get $arg0) (call $g2w (local.get $arg1)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 94: GetDlgCtrlID(hwnd) → control ID stored in CONTROL_TABLE[slot]+4
  (func $handle_GetDlgCtrlID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $arg0)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (global.set $eax (i32.const 0)))
      (else
        (global.set $eax (i32.load
          (i32.add (i32.add (global.get $CONTROL_TABLE)
                            (i32.mul (local.get $idx) (i32.const 16)))
                   (i32.const 4))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 95: GetDlgItemTextA(hDlg, nIDDlgItem, lpString, nMaxCount) → int
  ;; Implemented as GetDlgItem + WM_GETTEXT so the control's own wndproc
  ;; serves the text from its EditState / ButtonState / StaticState — the
  ;; JS _controlText Map that used to cache these strings is gone.
  (func $handle_GetDlgItemTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ctrl i32)
    (local.set $ctrl (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $ctrl)
      (then (global.set $eax
              (call $wnd_send_message (local.get $ctrl)
                (i32.const 0x000D)            ;; WM_GETTEXT
                (local.get $arg3)             ;; nMaxCount
                (local.get $arg2))))          ;; lpString (guest ptr)
      (else
        ;; Empty string on miss, matching Win32
        (if (i32.and (local.get $arg2) (i32.gt_u (local.get $arg3) (i32.const 0)))
          (then (i32.store8 (call $g2w (local.get $arg2)) (i32.const 0))))
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 96: GetDlgItem(hDlg, nIDDlgItem) → HWND of child control
  ;; Returns NULL if hDlg is 0 or child not found; otherwise real control HWND
  (func $handle_GetDlgItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32)
    ;; NULL parent → no dialog → return NULL
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; Look up real HWND from control table
    (local.set $result (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    ;; Fallback to synthetic HWND if not found (pre-control-table dialogs)
    (if (i32.eqz (local.get $result))
      (then (local.set $result (i32.or (i32.const 0x20000)
        (i32.and (local.get $arg1) (i32.const 0xFFFF))))))
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 97: GetCursorPos
  (func $handle_GetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg0) (i32.const 0))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 98: GetLastActivePopup(hWnd) — 1 arg stdcall
  ;; Returns the last active popup owned by hWnd. We don't track popups,
  ;; so return hWnd itself (correct when no popup is active, per Win32 docs).
  (func $handle_GetLastActivePopup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 99: GetFocus — STUB: unimplemented
  (func $handle_GetFocus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $focus_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

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
        ;; If old wndproc is WNDPROC_BUILTIN sentinel, return 0 (no real wndproc to chain)
        (if (i32.eq (global.get $eax) (global.get $WNDPROC_BUILTIN))
          (then (global.set $eax (i32.const 0))))
        ;; If old wndproc is 0 (not in table), fall back to global wndproc for main window
        (if (i32.and (i32.eqz (global.get $eax))
                     (i32.eq (local.get $arg0) (global.get $main_hwnd)))
          (then (global.set $eax (global.get $wndproc_addr))))
        (call $wnd_table_set (local.get $arg0) (local.get $arg2)) ;; set new wndproc
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -16))  ;; GWL_STYLE
      (then
        (global.set $eax (call $wnd_set_style (local.get $arg0) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; For other indices (exstyle, positive offsets), store in userdata for now
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
    (local $wa i32) (local $len i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $len (call $guest_strlen (local.get $arg1)))
    ;; Store in TITLE_TABLE so DefWindowProc WM_NCPAINT can redraw the
    ;; caption text from WAT-side state. Also post WM_NCPAINT.
    (call $title_table_set (local.get $arg0) (local.get $wa) (local.get $len))
    (call $nc_flags_set (local.get $arg0) (i32.const 1))
    (call $host_set_window_text (local.get $arg0) (local.get $wa))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 103: SetDlgItemTextA — delegate to the control's wndproc via
  ;; WM_SETTEXT so EditState / ButtonState / StaticState own the string.
  (func $handle_SetDlgItemTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ctrl i32)
    (local.set $ctrl (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $ctrl)
      (then (drop (call $wnd_send_message (local.get $ctrl)
              (i32.const 0x000C)                    ;; WM_SETTEXT
              (i32.const 0)
              (local.get $arg2)))))                 ;; lpString (guest ptr)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 104: SetDlgItemInt(hDlg, nIDDlgItem, uValue, bSigned) — stub, ignore
  (func $handle_SetDlgItemInt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 105: SetForegroundWindow(hWnd) — 1 arg stdcall
  ;; Brings window to foreground. Single-window model: always succeeds.
  (func $handle_SetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; Helper: apply a new cursor and return the previous handle. Shared by
  ;; $handle_SetCursor and DefWindowProc's WM_SETCURSOR path.
  (func $set_cursor_internal (param $hcur i32) (result i32)
    (local $prev i32)
    (local.set $prev (global.get $current_cursor))
    (global.set $current_cursor (local.get $hcur))
    (call $host_set_cursor (local.get $hcur))
    (local.get $prev))

  ;; 106: SetCursor(hCursor) — 1 arg stdcall, returns previous HCURSOR.
  (func $handle_SetCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $set_cursor_internal (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 107: SetFocus(hwnd) — 1 arg stdcall, return previous focus hwnd
  (func $handle_SetFocus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wndproc i32) (local $prev i32) (local $ret_addr i32)
    (local.set $prev (global.get $focus_hwnd))
    (global.set $eax (local.get $prev))
    ;; Focus change: post WM_KILLFOCUS to outgoing window. The incoming
    ;; WM_SETFOCUS is delivered synchronously below (EIP redirect).
    (if (i32.and (i32.ne (local.get $prev) (local.get $arg0))
                 (i32.ne (local.get $prev) (i32.const 0)))
      (then
        (drop (call $post_queue_push
                (local.get $prev) (i32.const 0x0008)
                (local.get $arg0) (i32.const 0)))))
    (global.set $focus_hwnd (local.get $arg0))
    (local.set $wndproc (call $wnd_table_get (local.get $arg0)))
    ;; WAT-native wndproc: dispatch inline
    (if (i32.ge_u (local.get $wndproc) (i32.const 0xFFFF0000))
      (then (drop (call $wat_wndproc_dispatch
              (local.get $arg0) (i32.const 0x0007) (local.get $prev) (i32.const 0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; x86 wndproc: no entry means try globals
    (if (i32.eqz (local.get $wndproc))
      (then
        (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
          (then (local.set $wndproc (global.get $wndproc_addr))))))
    ;; Deliver WM_SETFOCUS synchronously by redirecting EIP to the wndproc.
    ;; SetFocus is stdcall(1 arg): stack = [ret, hwnd] = 8 bytes.
    ;; WndProc(hwnd, msg, wParam, lParam) is stdcall(4 args) = 20 bytes.
    (if (local.get $wndproc)
      (then
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 12))) ;; grow 8->20
        (call $gs32 (global.get $esp) (local.get $ret_addr))
        (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $arg0))     ;; hwnd
        (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.const 0x0007))    ;; WM_SETFOCUS
        (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $prev))    ;; wParam = prev focus
        (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (i32.const 0))        ;; lParam = 0
        (global.set $eip (local.get $wndproc))
        (global.set $steps (i32.const 0))
        (return)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 108: LoadCursorA(hInstance, lpCursorName) — return HCURSOR encoding the IDC_*.
  ;; System cursors: hInstance=0, lpCursorName is an ordinal (MAKEINTRESOURCE,
  ;; value < 0x10000) in the IDC_* range (32512..). Encoded handle:
  ;;   0x60000 | (IDC_X & 0xFFFF) — matches the JS load_cursor stub encoding.
  ;; App-resource cursors collapse to IDC_ARROW (bitmap cursor rendering deferred).
  (func $handle_LoadCursorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.eqz (local.get $arg0))
                 (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
      (then (global.set $eax (i32.or (i32.const 0x60000)
                                     (i32.and (local.get $arg1) (i32.const 0xFFFF)))))
      (else (global.set $eax (i32.const 0x67F00)))) ;; IDC_ARROW fallback
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 109: LoadIconA(hInstance, lpIconName) — return fake icon handle
  (func $handle_LoadIconA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x60001)) ;; fake HICON
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 110: LoadStringA
  (func $handle_LoadStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RT_STRING walker lives in WAT — see $string_load_a in 10-helpers.wat.
    ;; arg0 = hInstance — may be a satellite DLL (e.g. MCM's lang.dll). Route
    ;; the resource lookup to that module for the duration of the call.
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax (call $string_load_a
      (local.get $arg1)                ;; string ID
      (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
      (local.get $arg3)))              ;; max chars
    (call $pop_rsrc_ctx)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 111: LoadAcceleratorsA(hInstance, lpTableName)
  ;; Look up RT_ACCELERATOR=9 via $rsrc_find_data_wa; on hit, cache the
  ;; WASM addr + entry count so TranslateAcceleratorA can walk the table.
  ;; arg1 = lpTableName (MAKEINTRESOURCE int or guest string ptr).
  (func $handle_LoadAcceleratorsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $data i32)
    (call $push_rsrc_ctx (local.get $arg0))
    (local.set $data (call $rsrc_find_data_wa (i32.const 9) (local.get $arg1)))
    (call $pop_rsrc_ctx)
    (global.set $haccel_data (local.get $data))
    (global.set $haccel_count (i32.div_u (global.get $rsrc_last_size) (i32.const 8)))
    (global.set $haccel (i32.const 0x60001))
    (global.set $eax (i32.const 0x60001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 112: EnableWindow — STUB: unimplemented
  ;; EnableWindow(hWnd, bEnable) → BOOL (previous state)
  (func $handle_EnableWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; was previously enabled
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 113: EnableMenuItem(hMenu, uIDEnableItem, uEnable) — stub, return previous state
  (func $handle_EnableMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; EnableMenuItem(hMenu, uIDEnableItem, uEnable) — return previous state
    (global.set $eax (i32.const 0))  ;; MF_ENABLED (previous state)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 114: EndDialog(hDlg, nResult) — end modal dialog, set result
  (func $handle_EndDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $dlg_ended (i32.const 1))
    (global.set $dlg_result (local.get $arg1))
    ;; Don't set quit_flag — that kills the main message loop.
    ;; CACA0004 checks dlg_ended to exit the modal loop.
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 115: InvalidateRect
  (func $handle_InvalidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Route paint to main or child window
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
    (then (global.set $paint_pending (i32.const 1)))
    (else (if (i32.ne (local.get $arg0) (i32.const 0))
    (then (call $paint_queue_push (local.get $arg0))))))
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
    ;; arg1 = resource ID (MAKEINTRESOURCE if <= 0xFFFF, else string pointer)
    (local.set $tmp (call $host_gdi_load_bitmap (local.get $arg0)
      (if (result i32) (i32.gt_u (local.get $arg1) (i32.const 0xFFFF))
        (then (local.get $arg1))
        (else (i32.and (local.get $arg1) (i32.const 0xFFFF))))))
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
  ;; Real Win32 sends WM_SIZE after resizing; store pending size for ShowWindow delivery.
  (func $handle_MoveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cx i32) (local $cy i32)
    (call $host_move_window (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (i32.const 0))
    (call $ctrl_geom_sync (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (i32.const 0))
    ;; For non-main windows, record pending WM_SIZE for delivery by ShowWindow
    (if (i32.ne (local.get $arg0) (global.get $main_hwnd))
    (then
      (local.set $cx (i32.sub (local.get $arg3) (i32.const 6)))
      (if (i32.lt_s (local.get $cx) (i32.const 0)) (then (local.set $cx (i32.const 0))))
      (local.set $cy (i32.sub (local.get $arg4) (global.get $main_nc_height)))
      (if (i32.lt_s (local.get $cy) (i32.const 0)) (then (local.set $cy (i32.const 0))))
      (global.set $movewindow_pending_hwnd (local.get $arg0))
      (global.set $movewindow_pending_size
        (i32.or (i32.and (local.get $cx) (i32.const 0xFFFF))
                (i32.shl (local.get $cy) (i32.const 16))))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
  )

  ;; 121: CheckMenuRadioItem(hMenu, idFirst, idLast, idCheck, uFlags)
  ;; Unchecks items [idFirst..idLast], checks idCheck with radio bullet. Returns TRUE.
  ;; Menu item state is tracked in the renderer's menu model when available.
  (func $handle_CheckMenuRadioItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 122: CheckMenuItem(hMenu, uIDCheckItem, uCheck) → previous state
  ;; We don't track HMENU-to-window mapping directly, so walk every
  ;; window with a menu blob and toggle the first matching command id.
  ;; uCheck combines MF_BYCOMMAND/MF_BYPOSITION with MF_CHECKED (8) or
  ;; MF_UNCHECKED (0); MF_BYPOSITION isn't supported here — in practice
  ;; callers use MF_BYCOMMAND, which is what our id-based walk matches.
  (func $handle_CheckMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $menu_check_item_global
      (local.get $arg1)
      (i32.and (local.get $arg2) (i32.const 8))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 123: CheckRadioButton(hDlg, firstId, lastId, checkId) — clear all in
  ;; [firstId,lastId] and set checkId. Pure WAT path now that ButtonState
  ;; bit 1 is the source of truth.
  (func $handle_CheckRadioButton (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $id i32) (local $ctrl i32)
    (local.set $id (local.get $arg1))
    (block $done (loop $scan
      (br_if $done (i32.gt_u (local.get $id) (local.get $arg2)))
      (local.set $ctrl (call $ctrl_find_by_id (local.get $arg0) (local.get $id)))
      (if (local.get $ctrl)
        (then (call $ctrl_set_check_state (local.get $ctrl)
                (select (i32.const 1) (i32.const 0)
                  (i32.eq (local.get $id) (local.get $arg3))))
              (call $host_invalidate (local.get $ctrl))))
      (local.set $id (i32.add (local.get $id) (i32.const 1)))
      (br $scan)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 124: CheckDlgButton — WAT-only; the _checkStates Map in host-imports
  ;; is gone, ButtonState.flags bit 1 is the source of truth.
  (func $handle_CheckDlgButton (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ctrl_hwnd i32)
    (local.set $ctrl_hwnd (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $ctrl_hwnd)
      (then (call $ctrl_set_check_state (local.get $ctrl_hwnd) (local.get $arg2))
            (call $host_invalidate (local.get $ctrl_hwnd))))
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

  ;; 127: IsDialogMessageA(hDlg, lpMsg) — return 0 (not a dialog message, let app process)
  (func $handle_IsDialogMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
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
    ;; ScreenToClient(hwnd, lpPoint) — all windows at (0,0), so no-op
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
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
    (if (i32.eqz (global.get $help_topic_count))
      (then
        (if (local.get $arg1)
          (then (call $help_load_file (local.get $arg1))))))
    ;; If yielding for async help file load, return without adjusting stack
    (if (global.get $yield_reason) (then (return)))
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
  ;; DialogBoxParamA(hInstance, lpTemplateName, hWndParent, lpDialogFunc, dwInitParam)
  ;; Creates modal dialog, sends WM_INITDIALOG, enters message loop, returns EndDialog result
  (func $handle_DialogBoxParamA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32) (local $init_param i32)
    ;; arg0=hInstance, arg1=lpTemplateName (resource ID), arg2=hWndParent
    ;; arg3=lpDialogFunc, arg4=dwInitParam (from stack: [esp+24])
    (local.set $init_param (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    ;; Allocate HWND
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Set as dialog hwnd (and dedicated modal-pump hwnd so nested
    ;; CreateDialogParamA can't hijack the pump's hwnd-less fallback)
    (global.set $dlg_hwnd (local.get $hwnd))
    (global.set $dlg_pump_hwnd (local.get $hwnd))
    (global.set $dlg_ended (i32.const 0))
    (global.set $dlg_result (i32.const 0))
    (global.set $dlg_proc (local.get $arg3))
    ;; Register dialog proc in wnd_table before $dlg_load so the walker
    ;; can find the slot for WND_DLG_RECORDS, and so SendMessageA
    ;; routing finds the dlgProc immediately.
    (call $wnd_table_set (local.get $hwnd) (local.get $arg3))
    ;; Parse the RT_DIALOG template fully in WAT — allocates child hwnds,
    ;; fills CONTROL_TABLE + CONTROL_GEOM, sends WM_CREATE, stores header
    ;; state in WND_DLG_RECORDS[slot]. Handles int IDs and guest string
    ;; pointers (named entries) via $find_resource. Route resource lookup
    ;; through hInstance so templates in a satellite DLL resolve.
    (call $push_rsrc_ctx (local.get $arg0))
    (drop (call $dlg_load (local.get $hwnd) (local.get $arg1)))
    (call $pop_rsrc_ctx)
    ;; Tell the renderer the dialog has been loaded; JS reads geom /
    ;; style / controls from the dlg_* / ctrl_* exports.
    (call $host_dialog_loaded (local.get $hwnd) (local.get $arg2))
    ;; Fill dialog client area with COLOR_BTNFACE — template DlgProcs
    ;; typically don't handle WM_PAINT, expecting DefDlgProc to erase,
    ;; but our modal pump doesn't fall through to DefWindowProc on a
    ;; FALSE return from WM_PAINT. Without this, the back-canvas stays
    ;; transparent/teal between control bodies.
    (call $dlg_fill_bkgnd (local.get $hwnd))
    ;; Show the dialog — real DialogBoxParam auto-shows before WM_INITDIALOG
    (drop (call $host_show_window (local.get $hwnd) (i32.const 1)))
    ;; Save return address — we'll restore it when EndDialog is called
    (global.set $dlg_ret_addr (call $gl32 (global.get $esp)))
    ;; Clean DialogBoxParamA frame (ret + 5 args = 24 bytes)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    ;; Set up call to dialog proc: push args for DlgProc(hwnd, WM_INITDIALOG, 0, dwInitParam)
    ;; Return to dialog loop thunk which pumps messages until EndDialog
    (global.set $esp (i32.sub (global.get $esp) (i32.const 20)))  ;; 4 args + ret addr
    (call $gs32 (global.get $esp) (global.get $dlg_loop_thunk))  ;; ret → dialog message loop
    (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $hwnd))          ;; hDlg
    (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.const 0x0110))         ;; WM_INITDIALOG
    (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (i32.const 0))             ;; wParam (focus hwnd)
    (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $init_param))   ;; lParam
    ;; Set EIP to dialog proc and signal redirection (don't let caller override EIP)
    (global.set $eip (local.get $arg3))
    (global.set $steps (i32.const 0))
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

  ;; 140: MapWindowPoints(hWndFrom, hWndTo, lpPoints, cPoints) → int
  ;; Translate an array of POINTs from hWndFrom's client space into
  ;; hWndTo's. For direct parent↔child pairs (the common dialog case) the
  ;; delta is the child's CONTROL_GEOM xy. General N-level routing walks
  ;; up the parent chain on each side and sums offsets. Return value packs
  ;; dx (low 16) and dy (high 16), matching the Win32 contract.
  (func $handle_MapWindowPoints (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dx i32) (local $dy i32) (local $cur i32) (local $xy i32)
    (local $i i32) (local $p i32)
    ;; Accumulate origin of hWndFrom walking up to a common ancestor (we
    ;; simplify: walk each side fully; works when only one side is nested).
    (local.set $cur (local.get $arg0))
    (block $from_done (loop $from_walk
      (br_if $from_done (i32.eqz (local.get $cur)))
      (br_if $from_done (i32.eq (local.get $cur) (local.get $arg1)))
      (if (call $ctrl_table_get_class (local.get $cur))
        (then
          (local.set $xy (call $ctrl_get_xy_packed (local.get $cur)))
          (local.set $dx (i32.add (local.get $dx) (i32.and (local.get $xy) (i32.const 0xFFFF))))
          (local.set $dy (i32.add (local.get $dy) (i32.shr_u (local.get $xy) (i32.const 16))))))
      (local.set $cur (call $wnd_get_parent (local.get $cur)))
      (br $from_walk)))
    ;; Subtract origin of hWndTo the same way
    (local.set $cur (local.get $arg1))
    (block $to_done (loop $to_walk
      (br_if $to_done (i32.eqz (local.get $cur)))
      (br_if $to_done (i32.eq (local.get $cur) (local.get $arg0)))
      (if (call $ctrl_table_get_class (local.get $cur))
        (then
          (local.set $xy (call $ctrl_get_xy_packed (local.get $cur)))
          (local.set $dx (i32.sub (local.get $dx) (i32.and (local.get $xy) (i32.const 0xFFFF))))
          (local.set $dy (i32.sub (local.get $dy) (i32.shr_u (local.get $xy) (i32.const 16))))))
      (local.set $cur (call $wnd_get_parent (local.get $cur)))
      (br $to_walk)))
    ;; Apply to each POINT (or RECT = 2 POINTs, caller picks cPoints)
    (local.set $i (i32.const 0))
    (local.set $p (call $g2w (local.get $arg2)))
    (block $apply_done (loop $apply
      (br_if $apply_done (i32.ge_u (local.get $i) (local.get $arg3)))
      (i32.store (local.get $p)
        (i32.add (i32.load (local.get $p)) (local.get $dx)))
      (i32.store offset=4 (local.get $p)
        (i32.add (i32.load offset=4 (local.get $p)) (local.get $dy)))
      (local.set $p (i32.add (local.get $p) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $apply)))
    (global.set $eax (i32.or (i32.and (local.get $dx) (i32.const 0xFFFF))
                             (i32.shl (local.get $dy) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 141: SetWindowPos
  (func $handle_SetWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetWindowPos(hwnd, hWndInsertAfter, X, Y, cx, cy, uFlags)
    (local $cy i32) (local $uFlags i32)
    (local.set $cy (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $uFlags (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    ;; Pass uFlags to host so it can respect SWP_NOSIZE/SWP_NOMOVE independently
    (call $host_move_window (local.get $arg0) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $cy) (local.get $uFlags))
    (call $ctrl_geom_sync (local.get $arg0) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $cy) (local.get $uFlags))
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
  ;; DrawEdge(hdc, qrc, edge, grfFlags) — 4 args stdcall
  (func $handle_DrawEdge (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rc i32)
    (local.set $rc (call $g2w (local.get $arg1)))
    (global.set $eax (call $host_gdi_draw_edge
      (local.get $arg0)                      ;; hdc
      (i32.load (local.get $rc))             ;; left
      (i32.load offset=4 (local.get $rc))    ;; top
      (i32.load offset=8 (local.get $rc))    ;; right
      (i32.load offset=12 (local.get $rc))   ;; bottom
      (local.get $arg2)                      ;; edge
      (local.get $arg3)))                    ;; grfFlags
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 144: GetClipboardData — STUB: unimplemented
  (func $handle_GetClipboardData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )


  ;; 187: KillTimer(hwnd, nIDEvent) — clear the timer
  (func $handle_KillTimer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $timer_kill (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 188: SetTimer
  (func $handle_SetTimer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tid i32)
    (local.set $tid (local.get $arg1))
    ;; Auto-generate unique timer ID when caller passes 0
    (if (i32.eqz (local.get $tid))
      (then
        (global.set $auto_timer_id (i32.add (global.get $auto_timer_id) (i32.const 1)))
        (local.set $tid (global.get $auto_timer_id))))
    (call $timer_set (local.get $arg0) (local.get $tid) (local.get $arg2) (local.get $arg3))
    (global.set $eax (local.get $tid))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 189: FindWindowA(lpClassName, lpWindowName) — return NULL (no existing window found)
  (func $handle_FindWindowA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; NULL — no window found
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 915: SearchPathA(lpPath, lpFileName, lpExtension, nBufLen, lpBuffer, lpFilePart) — 6 args stdcall
  (func $handle_SearchPathA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $arg5 i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    ;; 6th arg (lpFilePart) lives at esp+20 (skip ret addr + 5 visible args)
    (local.set $arg5 (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $host_fs_search_path
      (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)        ;; bufLen
      (local.get $arg4)        ;; bufGA (guest addr, host g2w's)
      (local.get $arg5)        ;; filePartPtrGA
      (i32.const 0)))          ;; isWide=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; 914: DllUnregisterServer() — no-op, return S_OK
  (func $handle_DllUnregisterServer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 913: FindWindowExA(hwndParent, hwndChildAfter, lpszClass, lpszWindow) — return NULL
  (func $handle_FindWindowExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 190: BringWindowToTop(hWnd) — 1 arg stdcall
  ;; Sets window to top of Z-order. Single-window model: always succeeds.
  (func $handle_BringWindowToTop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
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

  ;; 193: ShellExecuteA(hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd)
  (func $handle_ShellExecuteA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_shell_execute
      (local.get $arg0)
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (if (result i32) (local.get $arg3) (then (call $g2w (local.get $arg3))) (else (i32.const 0)))
      (if (result i32) (local.get $arg4) (then (call $g2w (local.get $arg4))) (else (i32.const 0)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 24))))) ;; nShowCmd
    (drop (local.get $name_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args + ret
  )

  ;; 194: ShellAboutA(hwnd, szApp, szOtherStuff, hIcon) — show About dialog
  ;; ShellAbout's strings come straight from the guest call (szApp = arg1
  ;; = "Notepad", szOtherStuff = arg2 = "Version 4.10\nCopyright ...").
  ;; No PE version-resource parsing needed; WAT can build the dialog
  ;; entirely from the args. The host_shell_about import only logs (so the
  ;; existing [ShellAbout] log gate keeps firing); all rendering state
  ;; comes from $create_about_dialog → $host_register_dialog_frame +
  ;; $ctrl_create_child.
  (func $handle_ShellAboutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (drop (call $host_shell_about
      (local.get $dlg) (local.get $arg0) (call $g2w (local.get $arg1))))
    (call $create_about_dialog
      (local.get $dlg) (local.get $arg0)
      (local.get $arg1) (local.get $arg2))
    (global.set $eax (i32.const 1))
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

  ;; 197: DragQueryFileA(hDrop, iFile, lpszFile, cch) — no drag-drop, return 0 files
  (func $handle_DragQueryFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; If iFile=0xFFFFFFFF, return count of files (0)
    ;; Otherwise return 0 (no file at that index)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 198: DragFinish(hDrop) — free drop handle, no-op for us
  (func $handle_DragFinish (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 199: GetOpenFileNameA(lpOFN) — show modal Open dialog
  ;;
  ;; Builds a WAT-driven Open dialog (class 12), parks EIP at the
  ;; CACA0006 modal pump thunk via $modal_begin, and yields to JS.
  ;; The dialog's wndproc writes the chosen filename back into
  ;; OFN.lpstrFile and calls $modal_done(1/0) on OK/Cancel. The pump
  ;; restores eax/eip/esp on the next interpreter pass after that.
  (func $handle_GetOpenFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; OPENFILENAME.hwndOwner at +4
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_open_dialog (local.get $dlg) (local.get $owner) (i32.const 0) (local.get $arg0))
    ;; 1-arg stdcall: ret addr (4) + arg (4) = 8 bytes to pop on return.
    (call $modal_begin (local.get $dlg) (i32.const 8))
  )

  ;; 200: GetFileTitleA — STUB: unimplemented
  (func $handle_GetFileTitleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 201: ChooseFontA(lpCF) — show the WAT-driven Font picker with face/
  ;; style/size listboxes. On OK, writes chosen size back to LOGFONT.lfHeight.
  (func $handle_ChooseFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_font_dialog (local.get $dlg) (local.get $owner) (local.get $arg0))
    (call $modal_begin (local.get $dlg) (i32.const 8)))

  ;; 202: FindTextA(lpFR) — create modeless Find dialog, return HWND
  (func $handle_FindTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32) (local $owner i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; Read hwndOwner from FINDREPLACE struct at offset +4
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    ;; Bare host log line for the [FindTextA] gate. All renderer state is
    ;; created from inside $create_findreplace_dialog via host_register_dialog_frame.
    (drop (call $host_show_find_dialog (local.get $hwnd) (local.get $owner) (local.get $arg0)))
    (call $create_findreplace_dialog (local.get $hwnd) (local.get $owner) (local.get $arg0))
    (global.set $eax (local.get $hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 203: PageSetupDlgA(lpPS) — show placeholder modal dialog
  (func $handle_PageSetupDlgA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_stub_dialog (local.get $dlg) (local.get $owner) (i32.const 0x241))   ;; "Page Setup"
    (call $modal_begin (local.get $dlg) (i32.const 8)))

  ;; 204: CommDlgExtendedError() — return 0 (no error)
  (func $handle_CommDlgExtendedError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
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
    (local $i i32) (local $dst i32)
    ;; arg0=&argc, arg1=&argv, arg2=&envp
    (call $gs32 (local.get $arg0) (i32.const 1))     ;; argc = 1
    ;; Allocate argv array: argv[0] = ptr to exe name, argv[1] = 0
    (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
    (then
    (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 256)))
    ;; Copy exe name to acmdln_ptr
    (local.set $dst (call $g2w (global.get $msvcrt_acmdln_ptr)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (global.get $exe_name_len)))
      (i32.store8 (i32.add (local.get $dst) (local.get $i))
        (i32.load8_u (i32.add (global.get $exe_name_wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (local.get $dst) (global.get $exe_name_len)) (i32.const 0))
    ;; Write argv array at acmdln_ptr+128: [acmdln_ptr, 0]
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 128)) (global.get $msvcrt_acmdln_ptr))
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 132)) (i32.const 0))
    ;; envp at acmdln_ptr+136: [0]
    (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 136)) (i32.const 0))))
    (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 128)))  ;; argv
    (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 136))) ;; envp
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

  ;; 210: _initterm(start, end) — CRT init table walker
  ;; Iterates function pointers from [start] to [end), calling each non-NULL entry.
  ;; Uses continuation thunk (0xCACA0003) to chain calls through the emulator.
  (func $handle__initterm (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $fn i32)
    ;; Save return address and end pointer for continuation
    (global.set $initterm_ret (call $gl32 (global.get $esp)))
    (global.set $initterm_end (local.get $arg1))
    (global.set $initterm_ptr (local.get $arg0))
    ;; Clean _initterm frame (ret + 2 args = 12 bytes)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    ;; Find first non-NULL entry and call it
    (block $done (loop $scan
      (br_if $done (i32.ge_u (global.get $initterm_ptr) (global.get $initterm_end)))
      (local.set $fn (call $gl32 (global.get $initterm_ptr)))
      (global.set $initterm_ptr (i32.add (global.get $initterm_ptr) (i32.const 4)))
      (if (local.get $fn)
        (then
          ;; Push continuation thunk as return address, then jump to fn
          (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
          (call $gs32 (global.get $esp) (global.get $initterm_thunk))
          (global.set $eip (local.get $fn))
          (global.set $steps (i32.const 0))
          (return)))
      (br $scan)))
    ;; All entries processed — return to original caller
    (global.set $eip (global.get $initterm_ret))
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
    (local $tmp i32) (local $class_name_wa i32) (local $slot i32) (local $dst i32) (local $src i32)
    ;; WNDCLASSEX: cbSize(+0) style(+4) lpfnWndProc(+8) cbClsExtra(+12) cbWndExtra(+16)
    ;;   hInstance(+20) hIcon(+24) hCursor(+28) hbrBackground(+32) lpszMenuName(+36)
    ;;   lpszClassName(+40) hIconSm(+44)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))) ;; lpfnWndProc
    (local.set $class_name_wa (call $g2w (call $gl32 (i32.add (local.get $arg0) (i32.const 40)))))
    ;; Allocate class record (returns atom; WNDCLASSA filled in below)
    (global.set $eax (call $class_table_register (local.get $class_name_wa)))
    ;; Convert WNDCLASSEX(+4..+40) → WNDCLASSA(+0..+36) (skip cbSize, copy 9 dwords)
    ;; into the embedded WNDCLASSA at class record + 8.
    (local.set $slot (call $class_find_slot (local.get $class_name_wa)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $dst (call $class_wndclass_addr (local.get $slot)))
        (local.set $src (call $g2w (i32.add (local.get $arg0) (i32.const 4))))
        (call $memcpy (local.get $dst) (local.get $src) (i32.const 36))
        ;; Copy lpszClassName from WNDCLASSEX+40 to WNDCLASSA+36
        (i32.store (i32.add (local.get $dst) (i32.const 36))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 40))))))
    ;; Store first EXE-space wndproc as main (skip DLL-registered classes)
    (if (i32.and (i32.eqz (global.get $wndproc_addr))
      (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
               (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 32))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 242: RegisterClassA
  (func $handle_RegisterClassA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $class_name_wa i32) (local $slot i32) (local $dst i32)
    ;; WNDCLASSA: style(+0) lpfnWndProc(+4) cbClsExtra(+8) cbWndExtra(+12)
    ;;   hInstance(+16) hIcon(+20) hCursor(+24) hbrBackground(+28)
    ;;   lpszMenuName(+32) lpszClassName(+36)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4)))) ;; lpfnWndProc
    (local.set $class_name_wa (call $class_name_key (call $gl32 (i32.add (local.get $arg0) (i32.const 36)))))
    ;; Allocate class record (returns atom; WNDCLASSA filled in below)
    (global.set $eax (call $class_table_register (local.get $class_name_wa)))
    ;; Copy full WNDCLASSA into the embedded slot at class record + 8.
    (local.set $slot (call $class_find_slot (local.get $class_name_wa)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $dst (call $class_wndclass_addr (local.get $slot)))
        (call $memcpy (local.get $dst) (call $g2w (local.get $arg0)) (i32.const 40))))
    ;; Store first EXE-space wndproc as main (skip DLL-registered classes)
    (if (i32.and (i32.eqz (global.get $wndproc_addr))
      (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
               (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (local.get $arg0)))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 28))))))
    (global.set $eax (i32.const 0xC001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 243: BeginPaint
  (func $handle_BeginPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32) (local $brush i32)
    ;; Win98: BeginPaint sends WM_ERASEBKGND before returning. The default
    ;; handler fills the client area with the class's hbrBackground. Our
    ;; wndproc plumbing doesn't round-trip SendMessage cleanly for every
    ;; hwnd, so do the default erase inline: dialogs default to COLOR_BTNFACE+1,
    ;; other windows use the last-registered class brush. This is the
    ;; single source of dialog/client background fill — it replaces both
    ;; the old JS screen-canvas fallback and $dlg_fill_bkgnd creation-time
    ;; hooks.
    (local.set $brush (global.get $wndclass_bg_brush))
    (if (i32.eqz (local.get $brush)) (then (local.set $brush (i32.const 16)))) ;; COLOR_BTNFACE+1
    (drop (call $host_erase_background (local.get $arg0) (local.get $brush)))
    ;; Fill PAINTSTRUCT: hdc(+0), fErase(+4), rcPaint(+8: left,top,right,bottom)
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 64))
    (call $gs32 (local.get $arg1) (i32.add (local.get $arg0) (i32.const 0x40000))) ;; hdc = hwnd + 0x40000
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0)) ;; fErase = FALSE (we erased)
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

  ;; 248: GetSaveFileNameA(lpOFN) — show modal Save As dialog
  ;; Same UI as GetOpenFileName, just kind=1 → "Save As" title + "Save" button.
  (func $handle_GetSaveFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_open_dialog (local.get $dlg) (local.get $owner) (i32.const 1) (local.get $arg0))
    (call $modal_begin (local.get $dlg) (i32.const 8))
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

  ;; wvsprintfA(buf, fmt, arglist) — stdcall, 3 args
  (func $handle_wvsprintfA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wsprintf_impl
      (local.get $arg0) (local.get $arg1) (call $g2w (local.get $arg2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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
    (local $i i32) (local $dst i32)
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
      ;; ptr-to-ptr at +128
      (call $gs32 (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 128)) (global.get $msvcrt_acmdln_ptr))))
    (global.set $eax (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 128)))
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

  ;; 284: GetModuleFileNameW — write L"C:\<exe_name>\0" as wide string
  (func $handle_GetModuleFileNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $off i32)
    ;; "C:\" prefix
    (call $gs16 (local.get $arg1) (i32.const 0x43))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 2)) (i32.const 0x3A))
    (call $gs16 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0x5C))
    ;; Copy exe name as wide chars
    (local.set $off (i32.const 6))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (global.get $exe_name_len)))
      (call $gs16 (i32.add (local.get $arg1) (local.get $off))
        (i32.load8_u (i32.add (global.get $exe_name_wa) (local.get $i))))
      (local.set $off (i32.add (local.get $off) (i32.const 2)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    ;; NUL terminator
    (call $gs16 (i32.add (local.get $arg1) (local.get $off)) (i32.const 0))
    (global.set $eax (i32.add (global.get $exe_name_len) (i32.const 3)))
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
    (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image))))
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
    (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image))))
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
    ;; className is wide string for W version, but class_table_lookup_w handles it
    (if (global.get $wndproc_addr)
      (then (call $wnd_table_set (global.get $next_hwnd) (global.get $wndproc_addr))))
    ;; Flag to deliver WM_CREATE + WM_SIZE as first messages in GetMessageA
    (if (i32.eq (global.get $next_hwnd) (global.get $main_hwnd))
    (then
    (global.set $pending_wm_create (i32.const 2))
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
    (call $paint_queue_push (global.get $next_hwnd))
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
    (if (i32.and (i32.eqz (global.get $wndproc_addr))
      (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
               (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (local.get $arg0)))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 28)))))
    (else (if (i32.and (i32.eqz (global.get $wndproc_addr2))
      (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
               (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
    (then (global.set $wndproc_addr2 (local.get $tmp))))))
    (global.set $eax (i32.const 0xC001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 288: RegisterClassExW — STUB: unimplemented, return 1
  (func $handle_RegisterClassExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 289: DefWindowProcW — same as DefWindowProcA
  (func $handle_DefWindowProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; WM_CLOSE (0x10): call DestroyWindow(hwnd) — only quit if main/dialog window
    (if (i32.eq (local.get $arg1) (i32.const 0x0010))
    (then
    (if (i32.or (i32.eq (local.get $arg0) (global.get $main_hwnd))
                (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
    (then (global.set $quit_flag (i32.const 1))))))
    ;; WM_ERASEBKGND (0x14): fill client area with background brush
    (if (i32.eq (local.get $arg1) (i32.const 0x0014))
    (then
    (global.set $eax (call $host_erase_background (local.get $arg0) (global.get $wndclass_bg_brush)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 290: LoadCursorW(hInstance, lpCursorName) — same IDC encoding as LoadCursorA.
  (func $handle_LoadCursorW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.eqz (local.get $arg0))
                 (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
      (then (global.set $eax (i32.or (i32.const 0x60000)
                                     (i32.and (local.get $arg1) (i32.const 0xFFFF)))))
      (else (global.set $eax (i32.const 0x67F00))))
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

  ;; 294: SetWindowTextW(hwnd, lpString) → BOOL — delegate to host
  (func $handle_SetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_set_window_text (local.get $arg0) (call $g2w (local.get $arg1)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 295: GetWindowTextW(hwnd, lpString, nMaxCount) → int (chars copied)
  ;; Write empty wide string, return 0 (no title set)
  (func $handle_GetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0)) (i32.ne (local.get $arg2) (i32.const 0)))
      (then (i32.store16 (call $g2w (local.get $arg1)) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 296: SendMessageW — return 0, 4 args stdcall
  (func $handle_SendMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 297: PostMessageW — same as PostMessageA
  (func $handle_PostMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; Queue if room (max 64 messages, 16 bytes each, at WASM addr 0x400)
    (if (i32.lt_u (global.get $post_queue_count) (i32.const 64))
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

  ;; 302: GetKeyState(nVirtKey) → SHORT — 1 arg stdcall
  (func $handle_GetKeyState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 303: GetParent — STUB: unimplemented
  ;; GetParent(hwnd) — 1 arg stdcall, return parent hwnd or 0
  (func $handle_GetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wnd_get_parent (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 304: GetWindow(hWnd, uCmd) — 2 args stdcall
  ;; Returns related window (sibling, child, owner). No sibling/child tracking,
  ;; so return NULL for all commands. GW_OWNER(4) returns parent if set.
  (func $handle_GetWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $parent i32)
    ;; GW_HWNDFIRST(0) / GW_HWNDLAST(1): first/last sibling at same parent.
    (if (i32.eq (local.get $arg1) (i32.const 0))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $arg0)))
        (global.set $eax (call $wnd_find_first_child (local.get $parent)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (i32.eq (local.get $arg1) (i32.const 1))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $arg0)))
        (global.set $eax (call $wnd_find_last_child (local.get $parent)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_HWNDNEXT = 2
    (if (i32.eq (local.get $arg1) (i32.const 2))
      (then
        (global.set $eax (call $wnd_find_next_sibling (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_HWNDPREV = 3
    (if (i32.eq (local.get $arg1) (i32.const 3))
      (then
        (global.set $eax (call $wnd_find_prev_sibling (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_OWNER = 4 → return parent hwnd
    (if (i32.eq (local.get $arg1) (i32.const 4))
      (then
        (global.set $eax (call $wnd_get_parent (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_CHILD = 5 → first child of hwnd
    (if (i32.eq (local.get $arg1) (i32.const 5))
      (then
        (global.set $eax (call $wnd_find_first_child (local.get $arg0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 305: IsWindow — STUB: unimplemented
  ;; 307: IsWindow(hwnd) → BOOL — check if hwnd is valid
  (func $handle_IsWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Valid if it's main_hwnd, a dialog (0x10000+), or a child control (0x20000+)
    (global.set $eax (i32.or
      (i32.eq (local.get $arg0) (global.get $main_hwnd))
      (i32.ge_u (local.get $arg0) (i32.const 0x10000))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetClassInfoA(hInstance, lpClassName, lpWndClass) — 3 args stdcall, return FALSE
  (func $handle_GetClassInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetClassInfoA(hInstance, lpClassName, lpWndClass) → BOOL
    ;; Look up class in our class table; if found, copy saved WNDCLASS to output
    (local $slot i32) (local $src i32)
    (local.set $slot (call $class_find_slot (call $g2w (local.get $arg1))))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        ;; Found — copy 40-byte WNDCLASS from class record to output buffer
        (local.set $src (call $class_wndclass_addr (local.get $slot)))
        (call $memcpy (call $g2w (local.get $arg2)) (local.get $src) (i32.const 40))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; Not found — return FALSE
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

  ;; 316: SetStretchBltMode(hdc, mode) → previous mode — 2 args stdcall
  (func $handle_SetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; return BLACKONWHITE (previous mode)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; 321: lstrcpyW — NULL-safe per Win32 spec
  (func $handle_lstrcpyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.ne (local.get $arg0) (i32.const 0)) (i32.ne (local.get $arg1) (i32.const 0)))
      (then (call $guest_wcscpy (local.get $arg0) (local.get $arg1))))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 322: lstrcmpW(lpString1, lpString2) → int (cdecl-like but stdcall)
  (func $handle_lstrcmpW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p1 i32) (local $p2 i32) (local $c1 i32) (local $c2 i32)
    (local.set $p1 (call $g2w (local.get $arg0)))
    (local.set $p2 (call $g2w (local.get $arg1)))
    (block $done (loop $cmp
      (local.set $c1 (i32.load16_u (local.get $p1)))
      (local.set $c2 (i32.load16_u (local.get $p2)))
      (if (i32.lt_u (local.get $c1) (local.get $c2))
        (then (global.set $eax (i32.const -1))
          (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
      (if (i32.gt_u (local.get $c1) (local.get $c2))
        (then (global.set $eax (i32.const 1))
          (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
      (br_if $done (i32.eqz (local.get $c1)))
      (local.set $p1 (i32.add (local.get $p1) (i32.const 2)))
      (local.set $p2 (i32.add (local.get $p2) (i32.const 2)))
      (br $cmp)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

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

  ;; 325: wsprintfW — wide sprintf (cdecl, caller cleans up)
  ;; wsprintfW(buf, fmt, ...) — args start at esp+12 in guest memory
  (func $handle_wsprintfW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=buf (guest), arg1=fmt (guest), args on stack at esp+12
    (global.set $eax (call $wsprintf_impl_w
      (call $g2w (local.get $arg0))
      (call $g2w (local.get $arg1))
      (i32.add (call $g2w (global.get $esp)) (i32.const 8)))))

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

  ;; 330: InitializeCriticalSection(lpCriticalSection)
  ;; CRITICAL_SECTION: +0=DebugInfo, +4=LockCount, +8=RecursionCount, +0C=OwningThread, +10=LockSemaphore, +14=SpinCount
  (func $handle_InitializeCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32)
    (local.set $cs (call $g2w (local.get $arg0)))
    ;; Zero the struct then set LockCount = -1 (unlocked)
    (i32.store (local.get $cs) (i32.const 0))            ;; DebugInfo
    (i32.store offset=4 (local.get $cs) (i32.const -1))  ;; LockCount = -1 (unlocked)
    (i32.store offset=8 (local.get $cs) (i32.const 0))   ;; RecursionCount
    (i32.store offset=12 (local.get $cs) (i32.const 0))  ;; OwningThread
    (i32.store offset=16 (local.get $cs) (i32.const 0))  ;; LockSemaphore
    (i32.store offset=20 (local.get $cs) (i32.const 0))  ;; SpinCount
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 331: EnterCriticalSection(lpCriticalSection) — single-threaded: always succeeds
  (func $handle_EnterCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32)
    (local.set $cs (call $g2w (local.get $arg0)))
    ;; LockCount: -1 -> 0 (first acquire) or increment (recursive)
    (i32.store offset=4 (local.get $cs)
      (i32.add (i32.load offset=4 (local.get $cs)) (i32.const 1)))
    ;; RecursionCount++
    (i32.store offset=8 (local.get $cs)
      (i32.add (i32.load offset=8 (local.get $cs)) (i32.const 1)))
    ;; OwningThread = 1 (our single thread ID)
    (i32.store offset=12 (local.get $cs) (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 332: LeaveCriticalSection(lpCriticalSection)
  (func $handle_LeaveCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32)
    (local.set $cs (call $g2w (local.get $arg0)))
    ;; RecursionCount--
    (i32.store offset=8 (local.get $cs)
      (i32.sub (i32.load offset=8 (local.get $cs)) (i32.const 1)))
    ;; If RecursionCount == 0, clear OwningThread
    (if (i32.eqz (i32.load offset=8 (local.get $cs)))
      (then
        (i32.store offset=12 (local.get $cs) (i32.const 0))
      )
    )
    ;; LockCount--
    (i32.store offset=4 (local.get $cs)
      (i32.sub (i32.load offset=4 (local.get $cs)) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 333: DeleteCriticalSection(lpCriticalSection)
  (func $handle_DeleteCriticalSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32)
    (local.set $cs (call $g2w (local.get $arg0)))
    (i32.store (local.get $cs) (i32.const 0))
    (i32.store offset=4 (local.get $cs) (i32.const -1))
    (i32.store offset=8 (local.get $cs) (i32.const 0))
    (i32.store offset=12 (local.get $cs) (i32.const 0))
    (i32.store offset=16 (local.get $cs) (i32.const 0))
    (i32.store offset=20 (local.get $cs) (i32.const 0))
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

  ;; 338: IsValidCodePage(CodePage) — emulator uses one code page; report all valid.
  (func $handle_IsValidCodePage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
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

  ;; InterlockedCompareExchange(ptr, newVal, comparand) → original
  ;; Atomic (single-threaded emu, so just sequential): if *ptr == comparand, *ptr = newVal.
  (func $handle_InterlockedCompareExchange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $orig i32)
    (local.set $orig (call $gl32 (local.get $arg0)))
    (global.set $eax (local.get $orig))
    (if (i32.eq (local.get $orig) (local.get $arg2))
      (then (call $gs32 (local.get $arg0) (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 972: GdiFlush() → BOOL — 0 args stdcall, no-op
  (func $handle_GdiFlush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 343: IsBadReadPtr(lp, ucb) → BOOL
  ;; Validates read access to memory range. Returns 0 if valid, 1 if bad.
  ;; Check if address falls within our WASM memory range.
  (func $handle_IsBadReadPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (select (i32.const 1) (i32.const 0)
      (i32.or (i32.eqz (local.get $arg0))
              (i32.gt_u (i32.add (local.get $arg0) (local.get $arg1)) (i32.const 0x02000000)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

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

  ;; 937: SetPriorityClass(hProcess, dwPriorityClass) — no-op, return TRUE
  (func $handle_SetPriorityClass (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 1264: GetPriorityClass(hProcess) — return NORMAL_PRIORITY_CLASS (0x20)
  (func $handle_GetPriorityClass (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x20))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 1265: GetThreadPriority(hThread) — return THREAD_PRIORITY_NORMAL (0)
  (func $handle_GetThreadPriority (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 1266: GetUpdateRgn(hWnd, hRgn, bErase) — return SIMPLEREGION (2)
  (func $handle_GetUpdateRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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

  ;; 356: GlobalHandle — our GlobalLock returns ptr as-is, so GlobalHandle returns same value
  (func $handle_GlobalHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 357: CreatePatternBrush(hBitmap) — 1 arg stdcall
  (func $handle_CreatePatternBrush (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_create_solid_brush (i32.const 0x00C0C0C0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 358: GetPaletteEntries(hPalette, iStart, nEntries, lppe) — 4 args stdcall
  (func $handle_GetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pal_idx i32) (local $src i32) (local $dst_wa i32) (local $count i32) (local $total i32)
    (local.set $pal_idx (i32.sub (local.get $arg0) (i32.const 0x000A0001)))
    (if (i32.and (i32.ge_s (local.get $pal_idx) (i32.const 0)) (i32.lt_u (local.get $pal_idx) (i32.const 4)))
      (then
        (local.set $total (i32.load (i32.add (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8))) (i32.const 4))))
        ;; If lppe is NULL, return total count
        (if (i32.eqz (local.get $arg3))
          (then
            (global.set $eax (local.get $total))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
            (return)))
        ;; Clamp nEntries to available
        (local.set $count (local.get $arg2))
        (if (i32.gt_u (i32.add (local.get $arg1) (local.get $count)) (local.get $total))
          (then (local.set $count (i32.sub (local.get $total) (local.get $arg1)))))
        ;; Copy entries
        (local.set $src (i32.add (i32.add (i32.const 0x6040) (i32.mul (local.get $pal_idx) (i32.const 1024)))
          (i32.mul (local.get $arg1) (i32.const 4))))
        (local.set $dst_wa (call $g2w (local.get $arg3)))
        (call $memcpy (local.get $dst_wa) (local.get $src) (i32.mul (local.get $count) (i32.const 4)))
        (global.set $eax (local.get $count)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; 4 args stdcall
  )

  ;; 359: SelectPalette(hdc, hPalette, bForceBackground) — 3 args stdcall
  ;; Store selected palette handle for this DC; return previous palette.
  ;; Also mirror the resolved palette index (0-3) at memory 0x6020 so the JS
  ;; StretchDIBits handler can resolve DIB_PAL_COLORS against the right table.
  (func $handle_SelectPalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $prev i32) (local $idx i32)
    (local.set $prev (global.get $selected_palette))
    (global.set $selected_palette (local.get $arg1))
    (local.set $idx (i32.sub (local.get $arg1) (i32.const 0x000A0001)))
    (if (i32.and (i32.ge_s (local.get $idx) (i32.const 0)) (i32.lt_u (local.get $idx) (i32.const 4)))
      (then (i32.store (i32.const 0x6020) (local.get $idx))))
    (global.set $eax (local.get $prev))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args stdcall
  )

  ;; 360: RealizePalette(hdc) — 1 arg stdcall
  ;; In true-color mode this is mostly a no-op; return number of entries mapped
  (func $handle_RealizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pal_idx i32)
    ;; Look up selected palette entry count
    (local.set $pal_idx (i32.sub (global.get $selected_palette) (i32.const 0x000A0001)))
    (if (result i32) (i32.and (i32.ge_s (local.get $pal_idx) (i32.const 0)) (i32.lt_u (local.get $pal_idx) (i32.const 4)))
      (then (i32.load (i32.add (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8))) (i32.const 4))))
      (else (i32.const 0)))
    global.set $eax
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg stdcall
  )

  ;; 361: CreateRectRgnIndirect — STUB: unimplemented
  (func $handle_CreateRectRgnIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateRectRgnIndirect(lprc) — 1 arg stdcall
    (global.set $rgn_counter (i32.add (global.get $rgn_counter) (i32.const 1)))
    (global.set $eax (i32.or (i32.const 0x00DD0000) (global.get $rgn_counter)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 362: GetObjectW — STUB: unimplemented
  (func $handle_GetObjectW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; SetTextAlign(hdc, fMode) — store alignment on the DC and return the previous value.
  (func $handle_SetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_text_align (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 364: ExtTextOutW(hdc, x, y, options, lprect, lpString, c, lpDx) — 8 args stdcall
  ;; Delegates to gdi_text_out in wide mode; clipping rect and lpDx are ignored
  ;; (matches ExtTextOutA behaviour — host reads UTF-16 LE directly).
  (func $handle_ExtTextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lpString i32) (local $count i32)
    (local.set $lpString (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; arg5
    (local.set $count    (call $gl32 (i32.add (global.get $esp) (i32.const 28)))) ;; arg6 (wchar count)
    (global.set $eax (call $host_gdi_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $g2w (local.get $lpString)) (local.get $count) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 365: PlayMetaFile — STUB: unimplemented
  (func $handle_PlayMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 366: CreatePalette(lpLogPalette) — 1 arg stdcall
  ;; LOGPALETTE: palVersion(u16, +0), palNumEntries(u16, +2), palPalEntry[](+4, each 4 bytes RGBX)
  ;; Store palette entries in WASM memory at 0x6040 + palette_idx * 1024
  ;; Palette handles: 0x000A0001+
  (func $handle_CreatePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src_wa i32) (local $num_entries i32) (local $pal_idx i32) (local $dst i32) (local $copy_bytes i32)
    (local.set $src_wa (call $g2w (local.get $arg0)))
    (local.set $num_entries (i32.load16_u (i32.add (local.get $src_wa) (i32.const 2))))
    ;; Cap at 256 entries
    (if (i32.gt_u (local.get $num_entries) (i32.const 256))
      (then (local.set $num_entries (i32.const 256))))
    ;; Allocate palette index (0-3)
    (local.set $pal_idx (i32.and (global.get $palette_counter) (i32.const 3)))
    (global.set $palette_counter (i32.add (global.get $palette_counter) (i32.const 1)))
    ;; Store entry count at 0x6000 + idx * 8
    (i32.store (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8)))
      (i32.add (i32.const 0x000A0001) (local.get $pal_idx)))  ;; handle
    (i32.store (i32.add (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8))) (i32.const 4))
      (local.get $num_entries))  ;; count
    ;; Copy palette entries (4 bytes each: R, G, B, flags)
    (local.set $dst (i32.add (i32.const 0x6040) (i32.mul (local.get $pal_idx) (i32.const 1024))))
    (local.set $copy_bytes (i32.mul (local.get $num_entries) (i32.const 4)))
    (call $memcpy (local.get $dst) (i32.add (local.get $src_wa) (i32.const 4)) (local.get $copy_bytes))
    ;; Return handle
    (global.set $eax (i32.add (i32.const 0x000A0001) (local.get $pal_idx)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg stdcall
  )

  ;; 367: GetNearestColor — STUB: unimplemented
  (func $handle_GetNearestColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; On true-color display, return the same color
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 368: StretchDIBits(hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, lpBits, lpBmi, usage, rop)
  ;; 13 args stdcall
  (func $handle_StretchDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_stretch_dib_bits
      (local.get $arg0)                                              ;; hdc
      (local.get $arg1)                                              ;; xDst
      (local.get $arg2)                                              ;; yDst
      (local.get $arg3)                                              ;; wDst
      (local.get $arg4)                                              ;; hDst
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))       ;; xSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))       ;; ySrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))       ;; wSrc
      (call $gl32 (i32.add (global.get $esp) (i32.const 36)))       ;; hSrc
      (call $g2w (call $gl32 (i32.add (global.get $esp) (i32.const 40))))  ;; lpBits → WASM addr
      (call $g2w (call $gl32 (i32.add (global.get $esp) (i32.const 44))))  ;; lpBmi → WASM addr
      (call $gl32 (i32.add (global.get $esp) (i32.const 48)))       ;; iUsage
      (call $gl32 (i32.add (global.get $esp) (i32.const 52)))       ;; dwRop
    ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 56))))

  ;; 369: OffsetRgn(hrgn, nXOffset, nYOffset) → region complexity
  (func $handle_OffsetRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_offset_rgn
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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

  ;; 374: RectVisible(hdc, lprc) — 2 args stdcall, return TRUE (always visible)
  (func $handle_RectVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 375: TextOutW(hdc, x, y, lpString, c) — 5 args stdcall, host reads UTF-16 LE.
  (func $handle_TextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $g2w (local.get $arg3)) (local.get $arg4) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
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

  ;; 379: CallNextHookEx — no next hook in chain, return 0
  (func $handle_CallNextHookEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CallNextHookEx(hhk, nCode, wParam, lParam) — 4 args stdcall
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 380: UnhookWindowsHookEx(hhk) → BOOL — always succeed
  (func $handle_UnhookWindowsHookEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 854: UnhookWindowsHook(nCode, pfnFilterProc) → BOOL — legacy version
  (func $handle_UnhookWindowsHook (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 381: SetWindowsHookExW — return fake handle, 4 args stdcall
  (func $handle_SetWindowsHookExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xBEEF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; SetWindowsHookExA — return fake handle, 4 args stdcall
  (func $handle_SetWindowsHookExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetWindowsHookExA(idHook, lpfn, hMod, dwThreadId)
    ;; Save CBT hook proc (WH_CBT = 5) for CreateWindowExA to call
    (if (i32.eq (local.get $arg0) (i32.const 5))
      (then (global.set $cbt_hook_proc (local.get $arg1))))
    (global.set $eax (i32.const 0xBEEF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 382: RedrawWindow — STUB: unimplemented
  (func $handle_RedrawWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 383: ValidateRect — STUB: unimplemented
  (func $handle_ValidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; ValidateRect(hWnd, lpRect) — 2 args stdcall
    ;; Marks the window region as valid (clears paint_pending).
    ;; If hWnd is main_hwnd, clear paint_pending.
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
      (then (global.set $paint_pending (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args
  )

  ;; 384: GetWindowDC — STUB: unimplemented
  (func $handle_GetWindowDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetWindowDC(hwnd) → HDC. Like GetDC but includes non-client area. 1 arg stdcall
    ;; Use 0xC0000 offset (vs GetDC's 0x40000) so JS can detect whole-window drawing
    (global.set $eax (i32.add (local.get $arg0) (i32.const 0xC0000)))
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

  ;; SystemParametersInfoA(uiAction, uiParam, pvParam, fWinIni) — 4 args stdcall
  (func $handle_SystemParametersInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $i i32)
    ;; SPI_GETNONCLIENTMETRICS = 0x29: fill NONCLIENTMETRICS struct
    ;; arg0=0x29, arg1=cbSize, arg2=pvParam (struct ptr)
    (if (i32.eq (local.get $arg0) (i32.const 0x29))
      (then
        (if (local.get $arg2)
          (then
            (local.set $buf (call $g2w (local.get $arg2)))
            ;; Zero the entire buffer first (caller's cbSize at [buf+0])
            (local.set $i (i32.const 0))
            (block $z (loop $zl
              (br_if $z (i32.ge_u (local.get $i) (local.get $arg1)))
              (i32.store8 (i32.add (local.get $buf) (local.get $i)) (i32.const 0))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $zl)))
            ;; cbSize, iBorderWidth, iScrollWidth, iScrollHeight, iCaptionWidth, iCaptionHeight
            (i32.store        (local.get $buf)                       (local.get $arg1))  ;; cbSize
            (i32.store offset=4  (local.get $buf) (i32.const 1))    ;; iBorderWidth
            (i32.store offset=8  (local.get $buf) (i32.const 16))   ;; iScrollWidth
            (i32.store offset=12 (local.get $buf) (i32.const 16))   ;; iScrollHeight
            (i32.store offset=16 (local.get $buf) (i32.const 18))   ;; iCaptionWidth
            (i32.store offset=20 (local.get $buf) (i32.const 18))   ;; iCaptionHeight
            ;; lfCaptionFont (LOGFONT, 60 bytes) at offset 24
            ;;   lfHeight (i32) = -11, then defaults; lfFaceName (32 bytes) = "MS Sans Serif"
            (i32.store offset=24 (local.get $buf) (i32.const -11))  ;; lfHeight
            (i32.store offset=40 (local.get $buf) (i32.const 400))  ;; lfWeight
            ;; faceName at offset 24+28 = 52: "MS Sans Serif\0"
            (i32.store8 offset=52 (local.get $buf) (i32.const 0x4D)) ;; M
            (i32.store8 offset=53 (local.get $buf) (i32.const 0x53)) ;; S
            (i32.store8 offset=54 (local.get $buf) (i32.const 0x20))
            (i32.store8 offset=55 (local.get $buf) (i32.const 0x53)) ;; S
            (i32.store8 offset=56 (local.get $buf) (i32.const 0x61))
            (i32.store8 offset=57 (local.get $buf) (i32.const 0x6E))
            (i32.store8 offset=58 (local.get $buf) (i32.const 0x73))
            (i32.store8 offset=59 (local.get $buf) (i32.const 0x20))
            (i32.store8 offset=60 (local.get $buf) (i32.const 0x53)) ;; S
            (i32.store8 offset=61 (local.get $buf) (i32.const 0x65))
            (i32.store8 offset=62 (local.get $buf) (i32.const 0x72))
            (i32.store8 offset=63 (local.get $buf) (i32.const 0x69))
            (i32.store8 offset=64 (local.get $buf) (i32.const 0x66))
            ;; Repeat the LOGFONT defaults at the other 4 font offsets:
            ;; lfSmCaptionFont @ +84+offset, lfMenuFont @ +148, lfStatusFont @ +212, lfMessageFont @ +276
            ;; (Each LOGFONT is 60 bytes; use the same minimal pattern.)
            (i32.store offset=84  (local.get $buf) (i32.const -11))
            (i32.store offset=100 (local.get $buf) (i32.const 400))
            (i32.store8 offset=112 (local.get $buf) (i32.const 0x4D)) (i32.store8 offset=113 (local.get $buf) (i32.const 0x53))
            (i32.store offset=148 (local.get $buf) (i32.const -11))
            (i32.store offset=164 (local.get $buf) (i32.const 400))
            (i32.store8 offset=176 (local.get $buf) (i32.const 0x4D)) (i32.store8 offset=177 (local.get $buf) (i32.const 0x53))
            (i32.store offset=212 (local.get $buf) (i32.const -11))
            (i32.store offset=228 (local.get $buf) (i32.const 400))
            (i32.store8 offset=240 (local.get $buf) (i32.const 0x4D)) (i32.store8 offset=241 (local.get $buf) (i32.const 0x53))
            (i32.store offset=276 (local.get $buf) (i32.const -11))
            (i32.store offset=292 (local.get $buf) (i32.const 400))
            (i32.store8 offset=304 (local.get $buf) (i32.const 0x4D)) (i32.store8 offset=305 (local.get $buf) (i32.const 0x53))))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 390: IsWindowVisible — STUB: unimplemented
  ;; IsWindowVisible(hWnd) → TRUE (windows are visible by default)
  (func $handle_IsWindowVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Check WS_VISIBLE bit in window style
    (global.set $eax
      (if (result i32) (i32.and (call $wnd_get_style (local.get $arg0)) (i32.const 0x10000000))
        (then (i32.const 1))
        (else (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 391: InflateRect(lprc, dx, dy) → BOOL — 3 args stdcall
  (func $handle_InflateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; left -= dx
    (i32.store (local.get $wa)
      (i32.sub (i32.load (local.get $wa)) (local.get $arg1)))
    ;; top -= dy
    (i32.store (i32.add (local.get $wa) (i32.const 4))
      (i32.sub (i32.load (i32.add (local.get $wa) (i32.const 4))) (local.get $arg2)))
    ;; right += dx
    (i32.store (i32.add (local.get $wa) (i32.const 8))
      (i32.add (i32.load (i32.add (local.get $wa) (i32.const 8))) (local.get $arg1)))
    ;; bottom += dy
    (i32.store (i32.add (local.get $wa) (i32.const 12))
      (i32.add (i32.load (i32.add (local.get $wa) (i32.const 12))) (local.get $arg2)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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
    ;; GetCapture() — 0 args, returns hwnd that has mouse capture (or NULL)
    (global.set $eax (global.get $capture_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; 0 args
  )

  ;; 398: RegisterClipboardFormatW(lpszFormat) → UINT
  ;; Returns a unique clipboard format ID (0xC000+ range for registered formats).
  ;; Uses a counter to assign unique IDs per format name.
  (func $handle_RegisterClipboardFormatW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $clipboard_fmt_counter (i32.add (global.get $clipboard_fmt_counter) (i32.const 1)))
    (global.set $eax (i32.add (i32.const 0xC000) (global.get $clipboard_fmt_counter)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 399: CopyRect(lprcDst, lprcSrc) → BOOL — 2 args stdcall
  (func $handle_CopyRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $src i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    (local.set $src (call $g2w (local.get $arg1)))
    (i32.store (local.get $dst) (i32.load (local.get $src)))
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (i32.load (i32.add (local.get $src) (i32.const 4))))
    (i32.store (i32.add (local.get $dst) (i32.const 8)) (i32.load (i32.add (local.get $src) (i32.const 8))))
    (i32.store (i32.add (local.get $dst) (i32.const 12)) (i32.load (i32.add (local.get $src) (i32.const 12))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; SubtractRect(lprcDst, lprcSrc1, lprcSrc2) → BOOL. Only well-defined when src2 fully covers
  ;; src1 in one axis; apps use it for update-region math. Approximation: copy src1→dst unless
  ;; src2 fully contains src1 (→ empty). Returns FALSE for empty result.
  (func $handle_SubtractRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $s1 i32) (local $s2 i32)
    (local $s1l i32) (local $s1t i32) (local $s1r i32) (local $s1b i32)
    (local $s2l i32) (local $s2t i32) (local $s2r i32) (local $s2b i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    (local.set $s1 (call $g2w (local.get $arg1)))
    (local.set $s2 (call $g2w (local.get $arg2)))
    (local.set $s1l (i32.load (local.get $s1)))
    (local.set $s1t (i32.load offset=4 (local.get $s1)))
    (local.set $s1r (i32.load offset=8 (local.get $s1)))
    (local.set $s1b (i32.load offset=12 (local.get $s1)))
    (local.set $s2l (i32.load (local.get $s2)))
    (local.set $s2t (i32.load offset=4 (local.get $s2)))
    (local.set $s2r (i32.load offset=8 (local.get $s2)))
    (local.set $s2b (i32.load offset=12 (local.get $s2)))
    ;; If src2 fully contains src1, result is empty.
    (if (i32.and
          (i32.and (i32.le_s (local.get $s2l) (local.get $s1l))
                   (i32.le_s (local.get $s2t) (local.get $s1t)))
          (i32.and (i32.ge_s (local.get $s2r) (local.get $s1r))
                   (i32.ge_s (local.get $s2b) (local.get $s1b))))
      (then
        (i32.store (local.get $dst) (i32.const 0))
        (i32.store offset=4 (local.get $dst) (i32.const 0))
        (i32.store offset=8 (local.get $dst) (i32.const 0))
        (i32.store offset=12 (local.get $dst) (i32.const 0))
        (global.set $eax (i32.const 0)))
      (else
        (i32.store (local.get $dst) (local.get $s1l))
        (i32.store offset=4 (local.get $dst) (local.get $s1t))
        (i32.store offset=8 (local.get $dst) (local.get $s1r))
        (i32.store offset=12 (local.get $dst) (local.get $s1b))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 402: WindowFromPoint — STUB: unimplemented
  (func $handle_WindowFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 403: IsRectEmpty — STUB: unimplemented
  (func $handle_IsRectEmpty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 404: EqualRect(lprc1, lprc2) → BOOL. Compares 4 LONGs (16 bytes).
  (func $handle_EqualRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $a i32) (local $b i32)
    (global.set $eax (i32.const 1))
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then (global.set $eax (i32.const 0)))
      (else
        (local.set $a (call $g2w (local.get $arg0)))
        (local.set $b (call $g2w (local.get $arg1)))
        (if (i32.or
              (i32.or (i32.ne (i32.load (local.get $a)) (i32.load (local.get $b)))
                      (i32.ne (i32.load offset=4 (local.get $a)) (i32.load offset=4 (local.get $b))))
              (i32.or (i32.ne (i32.load offset=8 (local.get $a)) (i32.load offset=8 (local.get $b)))
                      (i32.ne (i32.load offset=12 (local.get $a)) (i32.load offset=12 (local.get $b)))))
          (then (global.set $eax (i32.const 0))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 405: ClientToScreen
  (func $handle_ClientToScreen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; ClientToScreen(hwnd, lpPoint) — all windows at (0,0), so no-op
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 406: SetActiveWindow(hwnd) — return previous active window (fake: return arg)
  (func $handle_SetActiveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 407: RemoveMenu(hMenu, uPosition, uFlags) — return TRUE.
  ;; AppendMenuA/InsertMenuA are no-ops in this build (the menu bar is parsed
  ;; from the PE resource), so RemoveMenu has nothing real to remove either.
  (func $handle_RemoveMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 408: SetFilePointer — STUB: unimplemented
  (func $handle_SetFilePointer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetFilePointer(hFile, lDistanceToMove, lpDistanceToMoveHigh, dwMoveMethod) — 4 args
    (global.set $eax (call $host_fs_set_file_pointer
      (local.get $arg0) (local.get $arg1) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 409: ResumeThread — STUB: unimplemented
  ;; ResumeThread(hThread) — 1 arg stdcall, return previous suspend count
  ;; Threads are never actually suspended in our implementation, so return 1
  ;; (was suspended once via CREATE_SUSPENDED, now running).
  (func $handle_ResumeThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 412: RaiseException(dwExceptionCode, dwExceptionFlags, nNumberOfArguments, lpArguments)
  ;; 4 args stdcall. Pop first so SEH walker sees the caller's frame, then dispatch.
  (func $handle_RaiseException (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (call $raise_exception (local.get $arg0))
  )

  ;; 413: GetUserDefaultLCID — STUB: unimplemented
  (func $handle_GetUserDefaultLCID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return 0x0409 = English (US)
    (global.set $eax (i32.const 0x0409))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 414: FileTimeToSystemTime — STUB: unimplemented
  (func $handle_FileTimeToSystemTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FileTimeToSystemTime(lpFileTime, lpSystemTime) — 2 args
    (global.set $eax (call $host_fs_filetime_to_systemtime
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args
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
  ;; SetFileTime(hFile, lpCreationTime, lpLastAccessTime, lpLastWriteTime) — no-op
  (func $handle_SetFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; TRUE = success
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
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
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0)) (i32.gt_u (local.get $arg2) (local.get $len)))
      (then (call $memcpy (call $g2w (local.get $arg1)) (call $g2w (local.get $arg0)) (i32.add (local.get $len) (i32.const 1)))))
    (global.set $eax (local.get $len))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 438: FillRgn(hdc, hrgn, hbrush) → BOOL
  (func $handle_FillRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_fill_rgn
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; PaintRgn(hdc, hrgn) → BOOL — paint with DC's current brush
  (func $handle_PaintRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_fill_rgn
      (local.get $arg0) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 439: GetDIBColorTable(hdc, startIndex, numEntries, pColors) → count
  (func $handle_GetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_dib_color_table
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 440: SetDIBColorTable(hdc, startIndex, numEntries, pColors) → count
  (func $handle_SetDIBColorTable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 441: ResizePalette(hPalette, nEntries) — 2 args stdcall
  (func $handle_ResizePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pal_idx i32) (local $new_count i32)
    (local.set $pal_idx (i32.sub (local.get $arg0) (i32.const 0x000A0001)))
    (local.set $new_count (local.get $arg1))
    (if (i32.gt_u (local.get $new_count) (i32.const 256))
      (then (local.set $new_count (i32.const 256))))
    (if (i32.and (i32.ge_s (local.get $pal_idx) (i32.const 0)) (i32.lt_u (local.get $pal_idx) (i32.const 4)))
      (then
        (i32.store (i32.add (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8))) (i32.const 4))
          (local.get $new_count))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args stdcall
  )

  ;; 442: GetNearestPaletteIndex(hPalette, crColor) — 2 args stdcall
  ;; Find closest palette entry by color distance
  (func $handle_GetNearestPaletteIndex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pal_idx i32) (local $base i32) (local $count i32)
    (local $i i32) (local $best_i i32) (local $best_dist i32) (local $entry i32)
    (local $dr i32) (local $dg i32) (local $db i32) (local $dist i32)
    (local $tr i32) (local $tg i32) (local $tb i32)
    (local.set $pal_idx (i32.sub (local.get $arg0) (i32.const 0x000A0001)))
    (local.set $best_dist (i32.const 0x7FFFFFFF))
    ;; Target color components
    (local.set $tr (i32.and (local.get $arg1) (i32.const 0xFF)))
    (local.set $tg (i32.and (i32.shr_u (local.get $arg1) (i32.const 8)) (i32.const 0xFF)))
    (local.set $tb (i32.and (i32.shr_u (local.get $arg1) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.and (i32.ge_s (local.get $pal_idx) (i32.const 0)) (i32.lt_u (local.get $pal_idx) (i32.const 4)))
      (then
        (local.set $base (i32.add (i32.const 0x6040) (i32.mul (local.get $pal_idx) (i32.const 1024))))
        (local.set $count (i32.load (i32.add (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8))) (i32.const 4))))
        (block $done (loop $scan
          (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $entry (i32.load (i32.add (local.get $base) (i32.mul (local.get $i) (i32.const 4)))))
          ;; PALETTEENTRY is R,G,B,flags (byte order)
          (local.set $dr (i32.sub (i32.and (local.get $entry) (i32.const 0xFF)) (local.get $tr)))
          (local.set $dg (i32.sub (i32.and (i32.shr_u (local.get $entry) (i32.const 8)) (i32.const 0xFF)) (local.get $tg)))
          (local.set $db (i32.sub (i32.and (i32.shr_u (local.get $entry) (i32.const 16)) (i32.const 0xFF)) (local.get $tb)))
          (local.set $dist (i32.add (i32.add (i32.mul (local.get $dr) (local.get $dr))
            (i32.mul (local.get $dg) (local.get $dg))) (i32.mul (local.get $db) (local.get $db))))
          (if (i32.lt_u (local.get $dist) (local.get $best_dist))
            (then (local.set $best_dist (local.get $dist)) (local.set $best_i (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $scan)))))
    (global.set $eax (local.get $best_i))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args stdcall
  )

  ;; 443: SetPaletteEntries(hPalette, iStart, nEntries, lppe) — 4 args stdcall
  (func $handle_SetPaletteEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pal_idx i32) (local $dst i32) (local $src_wa i32) (local $count i32) (local $total i32)
    (local.set $pal_idx (i32.sub (local.get $arg0) (i32.const 0x000A0001)))
    (if (i32.and (i32.ge_s (local.get $pal_idx) (i32.const 0)) (i32.lt_u (local.get $pal_idx) (i32.const 4)))
      (then
        (local.set $total (i32.load (i32.add (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8))) (i32.const 4))))
        (local.set $count (local.get $arg2))
        (if (i32.gt_u (i32.add (local.get $arg1) (local.get $count)) (local.get $total))
          (then (local.set $count (i32.sub (local.get $total) (local.get $arg1)))))
        (local.set $dst (i32.add (i32.add (i32.const 0x6040) (i32.mul (local.get $pal_idx) (i32.const 1024)))
          (i32.mul (local.get $arg1) (i32.const 4))))
        (local.set $src_wa (call $g2w (local.get $arg3)))
        (call $memcpy (local.get $dst) (local.get $src_wa) (i32.mul (local.get $count) (i32.const 4)))
        (global.set $eax (local.get $count)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; 4 args stdcall
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

  ;; 447: CreateDIBSection(hdc, pbmi, usage, ppvBits, hSection, offset)
  ;; Allocates pixel buffer, creates bitmap handle, stores data pointer at ppvBits
  (func $handle_CreateDIBSection (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $w i32) (local $h i32) (local $bpp i32) (local $size i32) (local $ptr i32)
    (local.set $w (call $gl32 (i32.add (local.get $arg1) (i32.const 4))))
    (local.set $h (call $gl32 (i32.add (local.get $arg1) (i32.const 8))))
    (if (i32.lt_s (local.get $h) (i32.const 0))
      (then (local.set $h (i32.sub (i32.const 0) (local.get $h)))))
    (local.set $bpp (i32.and (i32.shr_u (call $gl32 (i32.add (local.get $arg1) (i32.const 12))) (i32.const 16)) (i32.const 0xFFFF)))
    ;; size = width * height * bytes_per_pixel
    (local.set $size (i32.mul (i32.mul (local.get $w) (local.get $h))
      (select (i32.shr_u (local.get $bpp) (i32.const 3)) (i32.const 1) (i32.gt_u (local.get $bpp) (i32.const 8)))))
    (if (i32.lt_s (local.get $size) (i32.const 4)) (then (local.set $size (i32.const 4))))
    (local.set $ptr (call $heap_alloc (local.get $size)))
    (if (local.get $arg3)
      (then (call $gs32 (local.get $arg3) (local.get $ptr))))
    ;; Register as a live DIB section: JS re-reads pixels from the guest heap buffer on every
    ;; BitBlt source resolve, so in-place guest draws become visible without explicit sync.
    (global.set $eax (call $host_gdi_create_dib_section
      (local.get $w) (local.get $h) (local.get $bpp)
      (call $g2w (local.get $ptr))
      (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 448: GetDIBits(hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, uUsage) — 7 args stdcall
  (func $handle_GetDIBits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $lpbmi i32) (local $uUsage i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $lpbmi (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $uUsage (i32.load (i32.add (local.get $wa_esp) (i32.const 28))))
    (global.set $eax (call $host_gdi_get_di_bits
      (local.get $arg0)              ;; hdc
      (local.get $arg1)              ;; hbmp
      (local.get $arg2)              ;; uStartScan
      (local.get $arg3)              ;; cScanLines
      (local.get $arg4)              ;; lpvBits (guest address)
      (if (result i32) (local.get $lpbmi) (then (call $g2w (local.get $lpbmi))) (else (i32.const 0)))  ;; lpbmi (WASM ptr)
      (local.get $uUsage)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; 7 args + ret
  )

  ;; 449: CreateDIBitmap(hdc, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage) — 6 args
  (func $handle_CreateDIBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg0=hdc, arg1=lpbmih, arg2=fdwInit, arg3=lpbInit, arg4=lpbmi
    ;; fuUsage at [ESP+24]
    (global.set $eax (call $host_gdi_create_dib_bitmap
      (call $g2w (local.get $arg4))   ;; lpbmi (BITMAPINFO: header + color table)
      (if (result i32) (local.get $arg3) (then (call $g2w (local.get $arg3))) (else (i32.const 0)))  ;; lpbInit
      (local.get $arg2)))             ;; fdwInit
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))) ;; 6 args + ret
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

  ;; 451: Polygon(hdc, lpPoints, nCount) — 3 args stdcall
  (func $handle_Polygon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_polygon
      (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args + ret
  )

  ;; 452: RoundRect — STUB: unimplemented
  (func $handle_RoundRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 453: ExtFloodFill — STUB: unimplemented
  (func $handle_ExtFloodFill (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 454: CreatePolygonRgn(lpPoints, cPoints, fnPolyFillMode) → HRGN
  ;; Compute bounding box of the points and delegate to CreateRectRgn.
  (func $handle_CreatePolygonRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pts i32) (local $n i32) (local $i i32)
    (local $x i32) (local $y i32)
    (local $minx i32) (local $miny i32) (local $maxx i32) (local $maxy i32)
    (local.set $pts (call $g2w (local.get $arg0)))
    (local.set $n (local.get $arg1))
    (local.set $minx (i32.const 0x7fffffff))
    (local.set $miny (i32.const 0x7fffffff))
    (local.set $maxx (i32.const 0x80000000))
    (local.set $maxy (i32.const 0x80000000))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_s (local.get $i) (local.get $n)))
      (local.set $x (i32.load (i32.add (local.get $pts) (i32.mul (local.get $i) (i32.const 8)))))
      (local.set $y (i32.load (i32.add (local.get $pts) (i32.add (i32.mul (local.get $i) (i32.const 8)) (i32.const 4)))))
      (if (i32.lt_s (local.get $x) (local.get $minx)) (then (local.set $minx (local.get $x))))
      (if (i32.lt_s (local.get $y) (local.get $miny)) (then (local.set $miny (local.get $y))))
      (if (i32.gt_s (local.get $x) (local.get $maxx)) (then (local.set $maxx (local.get $x))))
      (if (i32.gt_s (local.get $y) (local.get $maxy)) (then (local.set $maxy (local.get $y))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (if (i32.le_s (local.get $n) (i32.const 0)) (then
      (local.set $minx (i32.const 0)) (local.set $miny (i32.const 0))
      (local.set $maxx (i32.const 0)) (local.set $maxy (i32.const 0))))
    (global.set $eax (call $host_gdi_create_rect_rgn
      (local.get $minx) (local.get $miny) (local.get $maxx) (local.get $maxy)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 455: PolyBezier — STUB: unimplemented
  (func $handle_PolyBezier (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 456: Polyline — STUB: unimplemented
  (func $handle_Polyline (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 457: CreateHalftonePalette(hdc) — 1 arg stdcall
  ;; Return a palette handle for a standard 256-color halftone palette
  (func $handle_CreateHalftonePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pal_idx i32) (local $dst i32) (local $i i32) (local $r i32) (local $g i32) (local $b i32)
    (local.set $pal_idx (i32.and (global.get $palette_counter) (i32.const 3)))
    (global.set $palette_counter (i32.add (global.get $palette_counter) (i32.const 1)))
    ;; Store as 256-entry palette
    (i32.store (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8)))
      (i32.add (i32.const 0x000A0001) (local.get $pal_idx)))
    (i32.store (i32.add (i32.add (i32.const 0x6000) (i32.mul (local.get $pal_idx) (i32.const 8))) (i32.const 4))
      (i32.const 256))
    ;; Fill with 6x6x6 color cube + grays
    (local.set $dst (i32.add (i32.const 0x6040) (i32.mul (local.get $pal_idx) (i32.const 1024))))
    (local.set $i (i32.const 0))
    (block $done (loop $fill
      (br_if $done (i32.ge_u (local.get $i) (i32.const 216)))
      (local.set $r (i32.mul (i32.rem_u (local.get $i) (i32.const 6)) (i32.const 51)))
      (local.set $g (i32.mul (i32.rem_u (i32.div_u (local.get $i) (i32.const 6)) (i32.const 6)) (i32.const 51)))
      (local.set $b (i32.mul (i32.div_u (local.get $i) (i32.const 36)) (i32.const 51)))
      (i32.store (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
        (i32.or (i32.or (local.get $r) (i32.shl (local.get $g) (i32.const 8)))
          (i32.shl (local.get $b) (i32.const 16))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $fill)))
    ;; Fill remaining 40 with grays
    (block $done2 (loop $gray
      (br_if $done2 (i32.ge_u (local.get $i) (i32.const 256)))
      (local.set $r (i32.mul (i32.sub (local.get $i) (i32.const 216)) (i32.const 6)))
      (i32.store (i32.add (local.get $dst) (i32.mul (local.get $i) (i32.const 4)))
        (i32.or (i32.or (local.get $r) (i32.shl (local.get $r) (i32.const 8)))
          (i32.shl (local.get $r) (i32.const 16))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $gray)))
    (global.set $eax (i32.add (i32.const 0x000A0001) (local.get $pal_idx)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; 1 arg stdcall
  )

  ;; 458: EnableScrollBar — STUB: unimplemented
  (func $handle_EnableScrollBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 459: GetCaretPos — STUB: unimplemented
  (func $handle_GetCaretPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 460: GetUpdateRect(hwnd, lpRect, bErase) — return TRUE with full client rect.
  ;; This build does not track per-window dirty regions; BeginPaint always paints
  ;; the whole client area, so any caller asking "what is dirty?" is told the
  ;; entire client rect, matching what BeginPaint will hand them.
  (func $handle_GetUpdateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32)
    (if (local.get $arg1)
      (then
        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
        (call $gs32 (local.get $arg1) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 8))
          (i32.and (local.get $cs) (i32.const 0xFFFF)))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 12))
          (i32.shr_u (local.get $cs) (i32.const 16)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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

  ;; --- Additional Shell32 APIs ---

  ;; ShellExecuteW — same as A version, return >32 for success, 6 args
  (func $handle_ShellExecuteW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 33))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; ShellExecuteExA(lpExecInfo) — 1 arg, return TRUE
  (func $handle_ShellExecuteExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SHELLEXECUTEINFO.hInstApp at offset 28 = set to >32
    (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 28))) (i32.const 33))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DragQueryFileW — same as A, return 0 files, 4 args
  (func $handle_DragQueryFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; SHGetFileInfoW — same as A version, return 1, 5 args
  (func $handle_SHGetFileInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; ExtractIconExA(lpszFile, nIconIndex, phiconLarge, phiconSmall, nIcons) — 5 args, return 0 icons
  (func $handle_ExtractIconExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; Shell_NotifyIconA(dwMessage, lpData) — tray icon, return TRUE, 2 args
  (func $handle_Shell_NotifyIconA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; SHBrowseForFolderA(lpbi) — 1 arg, return NULL (user cancelled)
  (func $handle_SHBrowseForFolderA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; SHGetMalloc(ppMalloc) — return E_NOTIMPL, 1 arg
  (func $handle_SHGetMalloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (i32.store (call $g2w (local.get $arg0)) (i32.const 0))
    (global.set $eax (i32.const 0x80004001))  ;; E_NOTIMPL
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; SHFileOperationA(lpFileOp) — 1 arg, return 0 (success)
  (func $handle_SHFileOperationA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; RunFileDlg(hwndOwner, hIcon, lpszDir, lpszTitle, lpszDesc) — 5 args, no return value
  (func $handle_RunFileDlg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; ExitWindowsDialog(hwndOwner) — 1 arg, no meaningful return
  (func $handle_ExitWindowsDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; RegisterShellHook(hwnd, dwType) — 2 args, return TRUE
  (func $handle_RegisterShellHook (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ArrangeWindows(hwndParent, dwReserved, lpRect, cKids, lpKids) — 5 args, return count
  (func $handle_ArrangeWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 468: IsBadCodePtr(lpfn) — 1 arg stdcall
  ;; Returns 0 if the pointer is callable, nonzero otherwise. We trust the guest
  ;; (any non-null pointer in the guest address space is treated as valid).
  (func $handle_IsBadCodePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.eqz (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 473: SetConsoleCtrlHandler(HandlerRoutine, Add) → BOOL
  (func $handle_SetConsoleCtrlHandler (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 474: SetEnvironmentVariableW(lpName, lpValue) → BOOL — no-op, return success
  (func $handle_SetEnvironmentVariableW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 475: CompareStringA(Locale, dwCmpFlags, lpString1, cchCount1, lpString2, cchCount2) → int
  ;; Real byte-by-byte comparison. Returns CSTR_LESS_THAN(1), CSTR_EQUAL(2), CSTR_GREATER_THAN(3)
  (func $handle_CompareStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p1 i32) (local $p2 i32) (local $len1 i32) (local $len2 i32)
    (local $i i32) (local $c1 i32) (local $c2 i32) (local $minlen i32)
    (local.set $p1 (call $g2w (local.get $arg2)))
    (local.set $len1 (local.get $arg3))
    ;; arg4 = lpString2, read cchCount2 from stack
    (local.set $p2 (call $g2w (local.get $arg4)))
    (local.set $len2 (call $gl32 (i32.add (call $g2w (global.get $esp)) (i32.const 4))))
    ;; If len == -1, compute strlen
    (if (i32.eq (local.get $len1) (i32.const -1))
      (then (local.set $len1 (call $strlen_a (local.get $p1)))))
    (if (i32.eq (local.get $len2) (i32.const -1))
      (then (local.set $len2 (call $strlen_a (local.get $p2)))))
    (local.set $minlen (select (local.get $len1) (local.get $len2) (i32.lt_u (local.get $len1) (local.get $len2))))
    (block $cmp_done (loop $cmp
      (br_if $cmp_done (i32.ge_u (local.get $i) (local.get $minlen)))
      (local.set $c1 (i32.load8_u (i32.add (local.get $p1) (local.get $i))))
      (local.set $c2 (i32.load8_u (i32.add (local.get $p2) (local.get $i))))
      ;; NORM_IGNORECASE (flag 1): uppercase both
      (if (i32.and (local.get $arg1) (i32.const 1))
        (then
          (if (i32.and (i32.ge_u (local.get $c1) (i32.const 97)) (i32.le_u (local.get $c1) (i32.const 122)))
            (then (local.set $c1 (i32.sub (local.get $c1) (i32.const 32)))))
          (if (i32.and (i32.ge_u (local.get $c2) (i32.const 97)) (i32.le_u (local.get $c2) (i32.const 122)))
            (then (local.set $c2 (i32.sub (local.get $c2) (i32.const 32)))))))
      (if (i32.lt_u (local.get $c1) (local.get $c2))
        (then (global.set $eax (i32.const 1))
          (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
      (if (i32.gt_u (local.get $c1) (local.get $c2))
        (then (global.set $eax (i32.const 3))
          (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cmp)))
    ;; All compared bytes equal — compare lengths
    (global.set $eax (select (i32.const 1) (select (i32.const 3) (i32.const 2)
      (i32.gt_u (local.get $len1) (local.get $len2)))
      (i32.lt_u (local.get $len1) (local.get $len2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 476: CompareStringW(Locale, dwCmpFlags, lpString1, cchCount1, lpString2, cchCount2) → int
  (func $handle_CompareStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p1 i32) (local $p2 i32) (local $len1 i32) (local $len2 i32)
    (local $i i32) (local $c1 i32) (local $c2 i32) (local $minlen i32)
    (local.set $p1 (call $g2w (local.get $arg2)))
    (local.set $len1 (local.get $arg3))
    (local.set $p2 (call $g2w (local.get $arg4)))
    (local.set $len2 (call $gl32 (i32.add (call $g2w (global.get $esp)) (i32.const 4))))
    ;; If len == -1, compute wcslen
    (if (i32.eq (local.get $len1) (i32.const -1))
      (then (local.set $len1 (call $strlen_w (local.get $p1)))))
    (if (i32.eq (local.get $len2) (i32.const -1))
      (then (local.set $len2 (call $strlen_w (local.get $p2)))))
    (local.set $minlen (select (local.get $len1) (local.get $len2) (i32.lt_u (local.get $len1) (local.get $len2))))
    (block $cmp_done (loop $cmp
      (br_if $cmp_done (i32.ge_u (local.get $i) (local.get $minlen)))
      (local.set $c1 (i32.load16_u (i32.add (local.get $p1) (i32.mul (local.get $i) (i32.const 2)))))
      (local.set $c2 (i32.load16_u (i32.add (local.get $p2) (i32.mul (local.get $i) (i32.const 2)))))
      (if (i32.and (local.get $arg1) (i32.const 1))
        (then
          (if (i32.and (i32.ge_u (local.get $c1) (i32.const 97)) (i32.le_u (local.get $c1) (i32.const 122)))
            (then (local.set $c1 (i32.sub (local.get $c1) (i32.const 32)))))
          (if (i32.and (i32.ge_u (local.get $c2) (i32.const 97)) (i32.le_u (local.get $c2) (i32.const 122)))
            (then (local.set $c2 (i32.sub (local.get $c2) (i32.const 32)))))))
      (if (i32.lt_u (local.get $c1) (local.get $c2))
        (then (global.set $eax (i32.const 1))
          (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
      (if (i32.gt_u (local.get $c1) (local.get $c2))
        (then (global.set $eax (i32.const 3))
          (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cmp)))
    (global.set $eax (select (i32.const 1) (select (i32.const 3) (i32.const 2)
      (i32.gt_u (local.get $len1) (local.get $len2)))
      (i32.lt_u (local.get $len1) (local.get $len2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 477: IsValidLocale(Locale, dwFlags) → BOOL
  (func $handle_IsValidLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 478: EnumSystemLocalesA(lpLocaleEnumProc, dwFlags) → BOOL — no-op
  (func $handle_EnumSystemLocalesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 479: GetLocaleInfoW(Locale, LCType, lpLCData, cchData) → chars written
  ;; Returns locale info as wide string. Common LCTypes:
  ;; 0x0E=LOCALE_SDECIMAL, 0x0F=LOCALE_STHOUSAND, 0x01=LOCALE_ILANGUAGE
  (func $handle_GetLocaleInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; If cchData==0, return required size
    (if (i32.eqz (local.get $arg3))
      (then (global.set $eax (i32.const 2))  ;; 1 char + NUL
             (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Write a default single-char response based on LCType
    (if (i32.eq (local.get $arg1) (i32.const 0x0E))  ;; LOCALE_SDECIMAL
      (then (call $gs16 (local.get $arg2) (i32.const 0x2E))  ;; "."
             (call $gs16 (i32.add (local.get $arg2) (i32.const 2)) (i32.const 0))
             (global.set $eax (i32.const 2))
             (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const 0x0F))  ;; LOCALE_STHOUSAND
      (then (call $gs16 (local.get $arg2) (i32.const 0x2C))  ;; ","
             (call $gs16 (i32.add (local.get $arg2) (i32.const 2)) (i32.const 0))
             (global.set $eax (i32.const 2))
             (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Default: return "0" + NUL
    (call $gs16 (local.get $arg2) (i32.const 0x30))
    (call $gs16 (i32.add (local.get $arg2) (i32.const 2)) (i32.const 0))
    (global.set $eax (i32.const 2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

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

  ;; 483: GetDiskFreeSpaceA(lpRoot, lpSectorsPerCluster, lpBytesPerSector, lpFreeClusters, lpTotalClusters)
  (func $handle_GetDiskFreeSpaceA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Report ~2GB free on a ~4GB disk (8 sectors/cluster, 512 bytes/sector)
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 8))))     ;; SectorsPerCluster
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (i32.const 512))))   ;; BytesPerSector
    (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (i32.const 524288)))) ;; FreeClusters (~2GB)
    (if (local.get $arg4) (then (call $gs32 (local.get $arg4) (i32.const 1048576)))) ;; TotalClusters (~4GB)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 484: GetLogicalDrives() — return bitmask of drives (bit 2 = C:)
  (func $handle_GetLogicalDrives (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x04))  ;; C: drive only
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; GetLogicalDriveStringsA(nBufferLength, lpBuffer) — return double-null-terminated drive list "C:\\\0\0"
  ;; If nBufferLength=0 or too small, returns required buffer size (5). Otherwise writes "C:\\\0\0" and returns 4 (chars excl. final null).
  (func $handle_GetLogicalDriveStringsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    (if (i32.lt_u (local.get $arg0) (i32.const 5))
      (then (global.set $eax (i32.const 5)))
      (else
        (local.set $buf (call $g2w (local.get $arg1)))
        (i32.store8 (local.get $buf) (i32.const 0x43))              ;; 'C'
        (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 0x3A))  ;; ':'
        (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 0x5C))  ;; '\\'
        (i32.store8 (i32.add (local.get $buf) (i32.const 3)) (i32.const 0))
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0))
        (global.set $eax (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; GetKeyboardType(nTypeFlag) → int. Enhanced 101/102-key (type 4, 12 func keys).
  ;; nTypeFlag: 0=type, 1=subtype, 2=num func keys. We report type=4, subtype=0, keys=12.
  (func $handle_GetKeyboardType (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (select (i32.const 12)
        (select (i32.const 0) (i32.const 4) (i32.eq (local.get $arg0) (i32.const 1)))
        (i32.eq (local.get $arg0) (i32.const 2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; GetKeyboardLayout(idThread) → HKL. Return US English (0x04090409, device+lang both en-US).
  (func $handle_GetKeyboardLayout (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x04090409))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; GetKeyboardLayoutList(nBuff, lpList) — report one layout (US English).
  ;; If lpList non-NULL and nBuff>=1, write HKL 0x04090409. Return total count (1).
  (func $handle_GetKeyboardLayoutList (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.ne (local.get $arg1) (i32.const 0)) (i32.ge_s (local.get $arg0) (i32.const 1)))
      (then (i32.store (call $g2w (local.get $arg1)) (i32.const 0x04090409))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; GetTextCharacterExtra(hdc) → int. Inter-character spacing (0 = default).
  (func $handle_GetTextCharacterExtra (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
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

  ;; 504: ReadConsoleA(hConsole, lpBuffer, nCharsToRead, lpCharsRead, lpReserved) → BOOL
  (func $handle_ReadConsoleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 505: SetConsoleMode(hConsole, dwMode) → BOOL
  (func $handle_SetConsoleMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $console_mode (local.get $arg1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 506: GetConsoleMode(hConsole, lpMode) → BOOL
  (func $handle_GetConsoleMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (i32.store (call $g2w (local.get $arg1)) (global.get $console_mode))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 507: WriteConsoleA — delegates to console buffer write
  (func $handle_WriteConsoleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $ch i32) (local $off i32) (local $src i32)
    (local.set $src (call $g2w (local.get $arg1)))
    (local.set $i (i32.const 0))
    (block $done (loop $write
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg2)))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (if (i32.eq (local.get $ch) (i32.const 10))
        (then
          (global.set $console_cursor_x (i32.const 0))
          (global.set $console_cursor_y (i32.add (global.get $console_cursor_y) (i32.const 1))))
        (else (if (i32.eq (local.get $ch) (i32.const 13))
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

  ;; 508: GetFileInformationByHandle — STUB: unimplemented
  (func $handle_GetFileInformationByHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 509: PeekNamedPipe — STUB: unimplemented
  (func $handle_PeekNamedPipe (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 510: ReadConsoleInputA(hConsole, lpBuffer, nLength, lpNumberOfEventsRead) → BOOL
  (func $handle_ReadConsoleInputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 511: PeekConsoleInputA(hConsole, lpBuffer, nLength, lpNumberOfEventsRead) → BOOL
  (func $handle_PeekConsoleInputA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 512: GetNumberOfConsoleInputEvents(hConsole, lpNumberOfEvents) → BOOL
  (func $handle_GetNumberOfConsoleInputEvents (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (i32.store (call $g2w (local.get $arg1)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 513: CreatePipe — STUB: unimplemented
  (func $handle_CreatePipe (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 514: GetSystemTimeAsFileTime(lpFileTime) — writes 8-byte FILETIME
  (func $handle_GetSystemTimeAsFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; Base: 2000-01-01 = 0x01BF53EB256D4000, add ticks*10000 (100ns units)
    (i32.store (local.get $wa)
      (i32.add (i32.const 0x256D4000) (i32.mul (call $host_get_ticks) (i32.const 10000))))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x01BF53EB))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 515: SetLocalTime — STUB: unimplemented
  (func $handle_SetLocalTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 516: GetSystemTime(lpSystemTime) — fills SYSTEMTIME with simulated time
  (func $handle_GetSystemTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $secs i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (local.set $secs (i32.div_u (call $host_get_ticks) (i32.const 1000)))
    (i32.store16 (local.get $wa) (i32.const 2000))
    (i32.store16 (i32.add (local.get $wa) (i32.const 2)) (i32.const 1))
    (i32.store16 (i32.add (local.get $wa) (i32.const 4)) (i32.const 6))
    (i32.store16 (i32.add (local.get $wa) (i32.const 6)) (i32.const 1))
    (i32.store16 (i32.add (local.get $wa) (i32.const 8))
      (i32.rem_u (i32.div_u (local.get $secs) (i32.const 3600)) (i32.const 24)))
    (i32.store16 (i32.add (local.get $wa) (i32.const 10))
      (i32.rem_u (i32.div_u (local.get $secs) (i32.const 60)) (i32.const 60)))
    (i32.store16 (i32.add (local.get $wa) (i32.const 12))
      (i32.rem_u (local.get $secs) (i32.const 60)))
    (i32.store16 (i32.add (local.get $wa) (i32.const 14))
      (i32.rem_u (call $host_get_ticks) (i32.const 1000)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 521: GetThreadLocale() → LCID — returns US English
  (func $handle_GetThreadLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0409))  ;; MAKELCID(LANG_ENGLISH, SUBLANG_ENGLISH_US)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 522: CreateSemaphoreW — STUB: unimplemented
  (func $handle_CreateSemaphoreW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 523: ReleaseSemaphore — STUB: unimplemented
  (func $handle_ReleaseSemaphore (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 524: CreateMutexW(lpMutexAttributes, bInitialOwner, lpName) → HANDLE
  ;; Returns a unique handle for the mutex. Single-threaded, so always succeeds.
  (func $handle_CreateMutexW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $eax (global.get $next_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 525: ReleaseMutex(hMutex) — single-threaded, always succeeds
  (func $handle_ReleaseMutex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; OpenMutexA(dwAccess, bInherit, lpName) — return 0 (not found) so single-instance checks
  ;; let the app fall through to CreateMutexA. Sets last error to ERROR_FILE_NOT_FOUND (2).
  (func $handle_OpenMutexA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $last_error (i32.const 2))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; CreateMutexA(lpAttr, bInitialOwner, lpName) — single-threaded, always succeeds with fresh handle
  (func $handle_CreateMutexA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $eax (global.get $next_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 526: CreateEventW(lpAttr, bManualReset, bInitialState, lpName) — 4 args stdcall
  (func $handle_CreateEventW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_create_event (local.get $arg1) (local.get $arg2)))
    (call $host_log_i32 (global.get $eax))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 527: WaitForMultipleObjects(nCount, lpHandles, bWaitAll, dwMilliseconds) — 4 args stdcall
  (func $handle_WaitForMultipleObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32)
    (local.set $result (call $host_wait_multiple (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2) (local.get $arg3)))
    (if (i32.eq (local.get $result) (i32.const 0xFFFF))
      (then
        (global.set $yield_reason (i32.const 1))
        (global.set $wait_handle (local.get $arg0)) ;; nCount
        (global.set $wait_handles_ptr (call $g2w (local.get $arg1)))
        (global.set $steps (i32.const 0))
        (return)))
    (global.set $eax (local.get $result))
    (call $host_log_i32 (global.get $eax))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 528: GlobalAddAtomW(lpString) — return unique atom, 1 arg stdcall
  (func $handle_GlobalAddAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $next_atom))
    (global.set $next_atom (i32.add (global.get $next_atom) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 529: FindResourceW — same as FindResourceA (resource IDs are integer MAKEINTRESOURCE values)
  (func $handle_FindResourceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax (call $find_resource (local.get $arg2) (local.get $arg1)))
    (call $pop_rsrc_ctx)
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

  ;; 534: SizeofResource(hModule, hResInfo) — return size from resource data entry
  (func $handle_SizeofResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; hResInfo (arg1) is offset from image_base to data entry (same as FindResource return)
    ;; Data entry: [RVA:4][Size:4][CodePage:4][Reserved:4]
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (global.set $eax (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $arg1) (i32.const 4)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 535: GetProcessVersion — 1 arg stdcall, return winver
  (func $handle_GetProcessVersion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $winver))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; GetProcessAffinityMask(hProcess, *processMask, *systemMask) → BOOL
  ;; Single-CPU emulator: report mask = 0x1 for both. Returns TRUE.
  (func $handle_GetProcessAffinityMask (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (i32.store (call $g2w (local.get $arg1)) (i32.const 1))))
    (if (local.get $arg2)
      (then (i32.store (call $g2w (local.get $arg2)) (i32.const 1))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; SetThreadAffinityMask(hThread, dwAffinityMask) → previous mask (DWORD_PTR)
  ;; Single-CPU emulator: always return 0x1 (the only valid mask). Nonzero = success.
  (func $handle_SetThreadAffinityMask (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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
    ;; SetThreadPriority(hThread, nPriority) — return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 1250: GetExitCodeThread(hThread, lpExitCode) — 2 args stdcall
  (func $handle_GetExitCodeThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Write exit code to lpExitCode
    (call $gs32 (local.get $arg1) (call $host_get_exit_code_thread (local.get $arg0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 540: SuspendThread — STUB: unimplemented
  ;; SuspendThread(hThread) — 1 arg stdcall, return previous suspend count (0 = not suspended)
  (func $handle_SuspendThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 813: GetWindowsDirectoryA(lpBuffer, uSize) → length
  (func $handle_GetWindowsDirectoryA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32)
    (local.set $dst (call $g2w (local.get $arg0)))
    ;; Write "C:\WINDOWS" (10 chars + null)
    (i32.store (local.get $dst) (i32.const 0x575c3a43))          ;; C:\W
    (i32.store (i32.add (local.get $dst) (i32.const 4)) (i32.const 0x4f444e49))   ;; INDO
    (i32.store16 (i32.add (local.get $dst) (i32.const 8)) (i32.const 0x5357))     ;; WS
    (i32.store8 (i32.add (local.get $dst) (i32.const 10)) (i32.const 0))          ;; NUL
    (global.set $eax (i32.const 10))
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

  ;; 550: GlobalDeleteAtom(nAtom) — no-op, return 0 (success)
  (func $handle_GlobalDeleteAtom (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 555: CombineRgn — call host to merge region objects
  (func $handle_CombineRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CombineRgn(hrgnDest, hrgnSrc1, hrgnSrc2, fnCombineMode) — 4 args stdcall
    (global.set $eax (call $host_gdi_combine_rgn
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 556: SetRectRgn — call host to update region object
  (func $handle_SetRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetRectRgn(hrgn, left, top, right, bottom) — 5 args stdcall.
    (global.set $eax (call $host_gdi_set_rect_rgn
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
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

  ;; 564: ExtSelectClipRgn(hdc, hrgn, fnMode) — 3 args stdcall
  (func $handle_ExtSelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_ext_select_clip_rgn
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 565: SelectClipPath — STUB: unimplemented
  (func $handle_SelectClipPath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 566: CreateRectRgn — call host to allocate real region object
  (func $handle_CreateRectRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateRectRgn(left, top, right, bottom) — 4 args stdcall
    (global.set $eax (call $host_gdi_create_rect_rgn
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 567: GetClipRgn(hdc, hrgn) — 2 args stdcall. Returns 1 if clip region set, 0 if none, -1 on error.
  (func $handle_GetClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; For now return 0 = no clip region (clip is applied JS-side, not visible as guest HRGN)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

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

  ;; 579: SelectClipRgn(hdc, hrgn) — 2 args stdcall
  (func $handle_SelectClipRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_select_clip_rgn
      (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 580: OffsetWindowOrgEx(hdc, dx, dy, lpPoint) → BOOL
  (func $handle_OffsetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $px i32) (local $py i32)
    (local.set $px (call $host_gdi_get_window_org_x (local.get $arg0)))
    (local.set $py (call $host_gdi_get_window_org_y (local.get $arg0)))
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3) (local.get $px))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (local.get $py))
    ))
    (drop (call $host_gdi_set_window_org (local.get $arg0)
      (i32.add (local.get $px) (local.get $arg1))
      (i32.add (local.get $py) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
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

  ;; 586: GetWindowOrgEx(hdc, lpPoint) → BOOL
  (func $handle_GetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1) (then
      (call $gs32 (local.get $arg1)
        (call $host_gdi_get_window_org_x (local.get $arg0)))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4))
        (call $host_gdi_get_window_org_y (local.get $arg0)))
    ))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 587: SetWindowOrgEx(hdc, X, Y, lpPoint) → BOOL. Stores new logical origin; subsequent GDI
  ;; calls translate by (viewport_org - window_org). lpPoint receives the previous origin.
  (func $handle_SetWindowOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3)
        (call $host_gdi_get_window_org_x (local.get $arg0)))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
        (call $host_gdi_get_window_org_y (local.get $arg0)))
    ))
    (drop (call $host_gdi_set_window_org (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
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

  ;; 591: OffsetViewportOrgEx(hdc, dx, dy, lpPoint) → BOOL
  (func $handle_OffsetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $px i32) (local $py i32)
    (local.set $px (call $host_gdi_get_viewport_org_x (local.get $arg0)))
    (local.set $py (call $host_gdi_get_viewport_org_y (local.get $arg0)))
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3) (local.get $px))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (local.get $py))
    ))
    (drop (call $host_gdi_set_viewport_org (local.get $arg0)
      (i32.add (local.get $px) (local.get $arg1))
      (i32.add (local.get $py) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 592: SetViewportOrgEx(hdc, x, y, lpPoint) → BOOL
  (func $handle_SetViewportOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg3) (then
      (call $gs32 (local.get $arg3)
        (call $host_gdi_get_viewport_org_x (local.get $arg0)))
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4))
        (call $host_gdi_get_viewport_org_y (local.get $arg0)))
    ))
    (drop (call $host_gdi_set_viewport_org (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
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

  ;; GetTextAlign(hdc) — return current alignment flags.
  (func $handle_GetTextAlign (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_text_align (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
  ;; GetTextColor(hdc) → COLORREF — 1 arg stdcall
  (func $handle_GetTextColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_text_color (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 600: GetStretchBltMode — STUB: unimplemented
  (func $handle_GetStretchBltMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 601: GetBkColor — STUB: unimplemented
  ;; GetBkColor(hdc) → COLORREF — 1 arg stdcall
  (func $handle_GetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_get_bk_color (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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

  ;; 605: GetClipBox(hdc, lpRect) → regionType — 2 args stdcall
  (func $handle_GetClipBox (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $sz i32)
    (local $wa i32)
    (local.set $sz (call $host_gdi_get_clip_box (local.get $arg0)))
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (local.get $wa) (i32.const 0))           ;; left
    (i32.store offset=4 (local.get $wa) (i32.const 0))  ;; top
    (i32.store offset=8 (local.get $wa)
      (i32.and (local.get $sz) (i32.const 0xFFFF)))      ;; right = width
    (i32.store offset=12 (local.get $wa)
      (i32.shr_u (local.get $sz) (i32.const 16)))        ;; bottom = height
    (global.set $eax (i32.const 2))  ;; SIMPLEREGION
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 606: GetTextFaceW — STUB: unimplemented
  (func $handle_GetTextFaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 607: MsgWaitForMultipleObjects(nCount, pHandles, fWaitAll, dwMilliseconds, dwWakeMask) → DWORD
  ;; 5 args stdcall = 24 bytes. Returns WAIT_OBJECT_0+i for signaled handle, or nCount for messages.
  (func $handle_MsgWaitForMultipleObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32)
    ;; Check if messages are pending first (post queue, paint, timers, host input)
    (if (i32.or
          (i32.gt_u (global.get $post_queue_count) (i32.const 0))
          (i32.or (global.get $paint_pending)
                  (i32.ne (call $host_check_input) (i32.const 0))))
      (then
        ;; Message available: return WAIT_OBJECT_0 + nCount
        (global.set $eax (local.get $arg0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; No messages — try waiting on handles (if any)
    (if (i32.gt_u (local.get $arg0) (i32.const 0))
      (then
        (local.set $result (call $host_wait_multiple
          (local.get $arg0) (call $g2w (local.get $arg1))
          (local.get $arg2) (i32.const 0)))  ;; poll with 0 timeout
        (if (i32.ne (local.get $result) (i32.const 0xFFFF))
          (then
            ;; A handle is signaled (or timeout=0 returned immediately)
            (if (i32.ne (local.get $result) (i32.const 0x102))  ;; not WAIT_TIMEOUT
              (then
                (global.set $eax (local.get $result))
                (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
                (return)))))))
    ;; Nothing ready — if timeout is 0, return WAIT_TIMEOUT
    (if (i32.eqz (local.get $arg3))
      (then
        (global.set $eax (i32.const 0x102))  ;; WAIT_TIMEOUT
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; Non-zero timeout: yield to JS event loop, will re-enter
    (global.set $yield_reason (i32.const 1))
    (global.set $steps (i32.const 0)))

  ;; 608: GetWindowPlacement(hWnd, lpwndpl) — 2 args stdcall
  ;; Fill WINDOWPLACEMENT with defaults: SW_SHOWNORMAL, zero min/max pts, 0,0,640,480 rect
  (func $handle_GetWindowPlacement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; length = 44
    (i32.store (local.get $wa) (i32.const 44))
    ;; flags = 0
    (i32.store offset=4 (local.get $wa) (i32.const 0))
    ;; showCmd = SW_SHOWNORMAL (1)
    (i32.store offset=8 (local.get $wa) (i32.const 1))
    ;; ptMinPosition = (0,0)
    (i32.store offset=12 (local.get $wa) (i32.const 0))
    (i32.store offset=16 (local.get $wa) (i32.const 0))
    ;; ptMaxPosition = (-1,-1)
    (i32.store offset=20 (local.get $wa) (i32.const -1))
    (i32.store offset=24 (local.get $wa) (i32.const -1))
    ;; rcNormalPosition = {0, 0, 640, 480}
    (i32.store offset=28 (local.get $wa) (i32.const 0))
    (i32.store offset=32 (local.get $wa) (i32.const 0))
    (i32.store offset=36 (local.get $wa) (i32.const 640))
    (i32.store offset=40 (local.get $wa) (i32.const 480))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 609: RegisterWindowMessageW — STUB: unimplemented
  (func $handle_RegisterWindowMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 610: GetForegroundWindow — STUB: unimplemented
  (func $handle_GetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetForegroundWindow() — 0 args, return active window handle
    (global.set $eax (global.get $main_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; 793: CallWindowProcA — call a WndProc with (hwnd, msg, wParam, lParam)
  ;; Stack on entry: [ret][lpPrevWndFunc][hWnd][Msg][wParam][lParam]
  ;; We set up a call frame to the WndProc so it returns to our caller.
  (func $handle_CallWindowProcA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32)
    ;; NULL wndproc — route TreeView messages or return 0
    (if (i32.eqz (local.get $arg0))
      (then
        ;; Route TreeView messages (0x1100-0x1150) to WAT-native TreeView
        (if (i32.and (i32.ge_u (local.get $arg2) (i32.const 0x1100))
                     (i32.le_u (local.get $arg2) (i32.const 0x1150)))
          (then
            (global.set $eax (call $treeview_dispatch
              (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; Sentinel 0xFFFE0001 = built-in control default wndproc — act as DefWindowProc
    (if (i32.eq (local.get $arg0) (global.get $WNDPROC_BUILTIN))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; If prevWndFunc is in thunk zone, dispatch inline (thunks can't be jumped to via EIP)
    (if (i32.and (i32.ge_u (local.get $arg0) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $arg0) (global.get $thunk_guest_end)))
      (then
        ;; Current stack: [ret][prevFunc][hWnd][Msg][wParam][lParam]
        ;; WndProc thunk expects: [ret][hWnd][Msg][wParam][lParam]
        ;; Write ret over prevFunc slot, then advance ESP by 4
        (call $gs32 (i32.add (global.get $esp) (i32.const 4))
          (call $gl32 (global.get $esp)))  ;; copy ret into prevFunc slot
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        ;; Now stack: [ret][hWnd][Msg][wParam][lParam] — correct for stdcall(4)
        ;; Dispatch the thunk directly
        (call $win32_dispatch (i32.div_u
          (i32.sub (local.get $arg0) (global.get $thunk_guest_base)) (i32.const 8)))
        (return)))
    ;; prevWndFunc is real x86 code — set up call frame and jump
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Clean CallWindowProcA stdcall frame: ret + 5 args = 24 bytes
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    ;; Push WndProc args (stdcall order: lParam, wParam, Msg, hWnd)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg4))   ;; lParam
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg3))   ;; wParam
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg2))   ;; Msg
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg1))   ;; hWnd
    ;; Push return address — WndProc returns directly to our caller
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Jump to WndProc
    (global.set $eip (local.get $arg0))
    (global.set $steps (i32.const 0))
  )

  ;; 632: BeginDeferWindowPos(nNumWindows) → HDWP handle
  (func $handle_BeginDeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xDEF00001))  ;; fake HDWP handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 633: DeferWindowPos(hWinPosInfo, hWnd, hWndInsertAfter, x, y, cx, cy, uFlags) → HDWP
  (func $handle_DeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Apply position immediately (no batching needed)
    ;; arg0=hDWP, arg1=hWnd, arg2=hInsertAfter, arg3=x, arg4=y, cx=stack[24], cy=stack[28], uFlags=stack[32]
    (call $host_move_window (local.get $arg1) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    ;; Refresh CLIENT_RECT now (MFC's AfxWndProc may not forward NCCALCSIZE to
    ;; DefWindowProc, so queuing the message alone doesn't update our table),
    ;; and queue a paint so the moved child redraws.
    (call $defwndproc_do_nccalcsize (local.get $arg1))
    (call $paint_queue_push (local.get $arg1))
    (global.set $eax (local.get $arg0))  ;; return same HDWP handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))  ;; stdcall, 8 args
  )

  ;; 631: EndDeferWindowPos(hWinPosInfo) → BOOL
  (func $handle_EndDeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; TRUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
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

  ;; 618: SetWindowPlacement(hWnd, lpwndpl) — 2 args stdcall
  ;; WINDOWPLACEMENT: length(0), flags(4), showCmd(8), ptMin(12,16), ptMax(20,24), rcNormal(28: left,top,right,bottom)
  (func $handle_SetWindowPlacement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; Read rcNormalPosition from WINDOWPLACEMENT at offset 28
    (local.set $left   (i32.load offset=28 (local.get $wa)))
    (local.set $top    (i32.load offset=32 (local.get $wa)))
    (local.set $right  (i32.load offset=36 (local.get $wa)))
    (local.set $bottom (i32.load offset=40 (local.get $wa)))
    ;; Move window to rcNormalPosition
    (call $host_move_window (local.get $arg0) (local.get $left) (local.get $top)
      (i32.sub (local.get $right) (local.get $left))
      (i32.sub (local.get $bottom) (local.get $top))
      (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
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
  ;; GetTopWindow(hWnd) → NULL (no child windows tracked)
  (func $handle_GetTopWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wnd_find_first_child (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 623: SetScrollPos(hwnd, nBar, nPos, bRedraw) → old pos
  (func $handle_SetScrollPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $base i32) (local $old i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        (local.set $old (i32.load (local.get $base)))
        (i32.store (local.get $base) (local.get $arg2))
        (global.set $eax (local.get $old)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 624: GetScrollPos(hwnd, nBar) → pos
  (func $handle_GetScrollPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $base i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        (global.set $eax (i32.load (local.get $base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 625: SetScrollRange(hwnd, nBar, nMinPos, nMaxPos, bRedraw) → BOOL
  (func $handle_SetScrollRange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $base i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        (i32.store offset=4 (local.get $base) (local.get $arg2))
        (i32.store offset=8 (local.get $base) (local.get $arg3))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 626: GetScrollRange(hwnd, nBar, lpMinPos, lpMaxPos) → BOOL
  (func $handle_GetScrollRange (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $base i32) (local $wmin i32) (local $wmax i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        (local.set $wmin (i32.load offset=4 (local.get $base)))
        (local.set $wmax (i32.load offset=8 (local.get $base)))))
    (if (local.get $arg2)
      (then (i32.store (call $g2w (local.get $arg2)) (local.get $wmin))))
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (local.get $wmax))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 627: ShowScrollBar(hwnd, wBar, bShow) → BOOL
  (func $handle_ShowScrollBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 628: SetScrollInfo(hwnd, nBar, lpsi, bRedraw) → pos
  (func $handle_SetScrollInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $base i32) (local $lpsi i32) (local $fMask i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (local.set $lpsi (call $g2w (local.get $arg2)))
    (local.set $fMask (i32.load offset=4 (local.get $lpsi)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        ;; SIF_RANGE = 0x01
        (if (i32.and (local.get $fMask) (i32.const 1))
          (then
            (i32.store offset=4 (local.get $base) (i32.load offset=8 (local.get $lpsi)))
            (i32.store offset=8 (local.get $base) (i32.load offset=12 (local.get $lpsi)))))
        ;; SIF_POS = 0x04
        (if (i32.and (local.get $fMask) (i32.const 4))
          (then
            (i32.store (local.get $base) (i32.load offset=20 (local.get $lpsi)))))
        (global.set $eax (i32.load (local.get $base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 629: GetScrollInfo(hwnd, nBar, lpsi) → BOOL
  (func $handle_GetScrollInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $base i32) (local $lpsi i32) (local $fMask i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (local.set $lpsi (call $g2w (local.get $arg2)))
    (local.set $fMask (i32.load offset=4 (local.get $lpsi)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        ;; SIF_RANGE = 0x01
        (if (i32.and (local.get $fMask) (i32.const 1))
          (then
            (i32.store offset=8 (local.get $lpsi) (i32.load offset=4 (local.get $base)))
            (i32.store offset=12 (local.get $lpsi) (i32.load offset=8 (local.get $base)))))
        ;; SIF_POS = 0x04
        (if (i32.and (local.get $fMask) (i32.const 4))
          (then
            (i32.store offset=20 (local.get $lpsi) (i32.load (local.get $base)))))
        ;; SIF_PAGE = 0x02 — not tracked, return 0
        (if (i32.and (local.get $fMask) (i32.const 2))
          (then
            (i32.store offset=16 (local.get $lpsi) (i32.const 0))))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 630: ScrollWindow(hWnd, XAmount, YAmount, lpRect, lpClipRect) — STUB: unimplemented
  (func $handle_ScrollWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 634: AdjustWindowRectEx(lpRect, dwStyle, bMenu, dwExStyle) — 4 args stdcall
  ;; Same as AdjustWindowRect but with extended style (ignored for now)
  (func $handle_AdjustWindowRectEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $border i32) (local $caption i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    ;; border (1px) when WS_BORDER|WS_DLGFRAME|WS_THICKFRAME present
    (local.set $border (i32.ne (i32.and (local.get $arg1) (i32.const 0x00CC0000)) (i32.const 0)))
    ;; caption (chrome 20px) only with WS_CAPTION (which == DLGFRAME|BORDER)
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 635: DispatchMessageW — same as DispatchMessageA (delegates to shared dispatch logic)
  (func $handle_DispatchMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $wndproc i32)
    ;; Skip WM_NULL — idle message, don't dispatch to WndProc
    (if (i32.eqz (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (then (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    ;; MM_TIMER (0x7FF0): multimedia timer callback — TimeProc(uTimerID, uMsg=0, dwUser, 0, 0)
    (if (i32.eq (call $gl32 (i32.add (local.get $arg0) (i32.const 4))) (i32.const 0x7FF0))
    (then
    (local.set $tmp (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $mm_timer_dwuser))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $tmp))
    (global.set $eip (call $gl32 (i32.add (local.get $arg0) (i32.const 12))))
    (global.set $steps (i32.const 0))
    (return)))
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
    ;; Built-in control wndproc — act as DefWindowProc (return 0)
    (if (i32.eq (local.get $wndproc) (global.get $WNDPROC_BUILTIN))
      (then
        (global.set $eax (i32.const 0))
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

  ;; 638: LoadAcceleratorsW — same as A (resource name may be int or UTF-16 string;
  ;; $rsrc_find_data_wa via $find_resource handles int IDs and ASCII, wide names fall
  ;; through as miss — freecell/solitaire use ASCII-compatible names).
  (func $handle_LoadAcceleratorsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $data i32)
    (call $push_rsrc_ctx (local.get $arg0))
    (local.set $data (call $rsrc_find_data_wa (i32.const 9) (local.get $arg1)))
    (call $pop_rsrc_ctx)
    (global.set $haccel_data (local.get $data))
    (global.set $haccel_count (i32.div_u (global.get $rsrc_last_size) (i32.const 8)))
    (global.set $haccel (i32.const 0x60001))
    (global.set $eax (i32.const 0x60001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 639: TranslateAcceleratorW — identical behaviour to A (MSG layout is the same).
  (func $handle_TranslateAcceleratorW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_TranslateAcceleratorA
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 640: IsWindowEnabled — STUB: unimplemented
  (func $handle_IsWindowEnabled (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; IsWindowEnabled(hwnd) — always return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
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
    ;; WaitMessage() — 0 args, return TRUE (message always available in our event loop)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 646: GetWindowThreadProcessId — STUB: unimplemented
  (func $handle_GetWindowThreadProcessId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetWindowThreadProcessId(hWnd, lpdwProcessId) → threadId
    ;; If lpdwProcessId is non-null, write process ID
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 1))))  ;; fake PID = 1
    (global.set $eax (i32.const 1))  ;; fake thread ID = 1
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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
    ;; Deliver pending WM_NCCREATE then WM_CREATE
    ;; pending_wm_create: 2=need NCCREATE, 1=need CREATE, 0=done
    (if (i32.eq (global.get $pending_wm_create) (i32.const 2))
    (then
    (global.set $pending_wm_create (i32.const 1))
    ;; Fill CREATESTRUCT at image_base+0x100
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x100)) (i32.const 0))  ;; lpCreateParams
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x110)) (global.get $main_win_cy))
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x114)) (global.get $main_win_cx))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0081)) ;; WM_NCCREATE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.add (global.get $image_base) (i32.const 0x100)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    (if (i32.eq (global.get $pending_wm_create) (i32.const 1))
    (then
    (global.set $pending_wm_create (i32.const 0))
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x100)) (i32.const 0))
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x110)) (global.get $main_win_cy))
    (call $gs32 (i32.add (global.get $image_base) (i32.const 0x114)) (global.get $main_win_cx))
    (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.add (global.get $image_base) (i32.const 0x100)))
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
    (call $gs32 (local.get $msg_ptr) (global.get $pending_child_create))
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
    ;; No paint — deliver WM_TIMER if any timer is due (consume=1)
    (if (call $timer_check_due (local.get $msg_ptr) (i32.const 1))
    (then
    (global.set $yield_flag (i32.const 1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; No timer due — return WM_NULL and yield to let browser process input events
    (global.set $yield_flag (i32.const 1))
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

  ;; 652: InvertRect(hdc, lpRect) — 2 args stdcall
  ;; Inverts pixels in the rectangle. Equivalent to BitBlt with DSTINVERT.
  (func $handle_InvertRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $left (i32.load (local.get $wa)))
    (local.set $top (i32.load (i32.add (local.get $wa) (i32.const 4))))
    (local.set $right (i32.load (i32.add (local.get $wa) (i32.const 8))))
    (local.set $bottom (i32.load (i32.add (local.get $wa) (i32.const 12))))
    (global.set $eax (call $host_gdi_bitblt
      (local.get $arg0) (local.get $left) (local.get $top)
      (i32.sub (local.get $right) (local.get $left))
      (i32.sub (local.get $bottom) (local.get $top))
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0x00550009)))  ;; DSTINVERT
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args + ret
  )

  ;; 653: IsZoomed(hwnd) → BOOL — returns TRUE if window is maximized
  ;; Windows in this emulator are never maximized
  (func $handle_IsZoomed (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; 654: SetParent — STUB: unimplemented
  (func $handle_SetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 655: AppendMenuW — STUB: unimplemented
  (func $handle_AppendMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; AppendMenuA(hMenu, uFlags, uIDNewItem, lpNewItem) — return TRUE
  (func $handle_AppendMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; InsertMenuA(hMenu, uPosition, uFlags, uIDNewItem, lpNewItem) — return TRUE
  (func $handle_InsertMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; ModifyMenuA(hMnu, uPosition, uFlags, uIDNewItem, lpNewItem) — return TRUE
  (func $handle_ModifyMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; RegisterDragDrop(hwnd, pDropTarget) — return S_OK.
  ;; No real drag/drop path: there is no host OS drop source to deliver IDataObjects
  ;; from, so tracking the IDropTarget would be pure bookkeeping. Return S_OK so
  ;; callers (e.g. Winamp) proceed; any later drop events simply never arrive.
  (func $handle_RegisterDragDrop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; RevokeDragDrop(hwnd) — return S_OK, matching the RegisterDragDrop no-op above.
  (func $handle_RevokeDragDrop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 656: DeleteMenu — STUB: unimplemented
  (func $handle_DeleteMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; DeleteMenu(hMenu, uPosition, uFlags) — return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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
  ;; GetAsyncKeyState(vKey) — stdcall(1). Reports current key state via host.
  (func $handle_GetAsyncKeyState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_get_async_key_state (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 663: MapDialogRect — STUB: unimplemented
  (func $handle_MapDialogRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 664: GetDialogBaseUnits() → DWORD (loword=X, hiword=Y base units)
  ;; Standard dialog units based on system font (8pt MS Sans Serif: 6x13)
  (func $handle_GetDialogBaseUnits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.or (i32.const 6) (i32.shl (i32.const 13) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 665: GetClassNameW — STUB: unimplemented
  (func $handle_GetClassNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 666: GetDlgItemInt(hDlg, nIDDlgItem, lpTranslated, bSigned) → UINT
  ;; Reads the child Edit control's WAT-side text buffer directly (via
  ;; state_ptr offsets that match $handle_edit_wndproc WM_GETTEXT) and
  ;; parses a decimal integer. bSigned lets a leading '-' flip the sign.
  ;; *lpTranslated receives TRUE iff at least one digit was consumed.
  (func $handle_GetDlgItemInt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $child i32) (local $state i32) (local $state_w i32)
    (local $buf_wa i32) (local $text_len i32)
    (local $i i32) (local $c i32) (local $val i32)
    (local $neg i32) (local $ok i32)
    (local.set $val (i32.const 0))
    (local.set $neg (i32.const 0))
    (local.set $ok  (i32.const 0))
    (local.set $child (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $child)
      (then
        (local.set $state (call $wnd_get_state_ptr (local.get $child)))
        (if (local.get $state)
          (then
            (local.set $state_w (call $g2w (local.get $state)))
            (local.set $text_len (i32.load offset=4 (local.get $state_w)))
            (if (i32.and
                  (i32.ne (i32.const 0) (i32.load (local.get $state_w)))
                  (i32.ne (i32.const 0) (local.get $text_len)))
              (then
                (local.set $buf_wa (call $g2w (i32.load (local.get $state_w))))
                (local.set $i (i32.const 0))
                (block $skip_done (loop $skip
                  (br_if $skip_done (i32.ge_u (local.get $i) (local.get $text_len)))
                  (br_if $skip_done (i32.ne
                    (i32.load8_u (i32.add (local.get $buf_wa) (local.get $i)))
                    (i32.const 0x20)))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $skip)))
                (if (i32.and (i32.ne (local.get $arg3) (i32.const 0))
                             (i32.lt_u (local.get $i) (local.get $text_len)))
                  (then
                    (if (i32.eq
                          (i32.load8_u (i32.add (local.get $buf_wa) (local.get $i)))
                          (i32.const 0x2D))
                      (then
                        (local.set $neg (i32.const 1))
                        (local.set $i (i32.add (local.get $i) (i32.const 1)))))))
                (block $parse_done (loop $parse
                  (br_if $parse_done (i32.ge_u (local.get $i) (local.get $text_len)))
                  (local.set $c (i32.load8_u (i32.add (local.get $buf_wa) (local.get $i))))
                  (br_if $parse_done (i32.lt_u (local.get $c) (i32.const 0x30)))
                  (br_if $parse_done (i32.gt_u (local.get $c) (i32.const 0x39)))
                  (local.set $val (i32.add
                    (i32.mul (local.get $val) (i32.const 10))
                    (i32.sub (local.get $c) (i32.const 0x30))))
                  (local.set $ok (i32.const 1))
                  (local.set $i (i32.add (local.get $i) (i32.const 1)))
                  (br $parse)))
                (if (local.get $neg)
                  (then (local.set $val (i32.sub (i32.const 0) (local.get $val)))))))))))
    (if (local.get $arg2)
      (then (call $gs32 (local.get $arg2) (local.get $ok))))
    (global.set $eax (local.get $val))
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

  ;; 669: IsDlgButtonChecked — BST_UNCHECKED(0) or BST_CHECKED(1)
  (func $handle_IsDlgButtonChecked (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ctrl_hwnd i32)
    (local.set $ctrl_hwnd (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $ctrl_hwnd)
      (then (global.set $eax (call $ctrl_get_check_state (local.get $ctrl_hwnd))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; 676: SetCursorPos(x, y) → BOOL — 2 args stdcall
  (func $handle_SetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 677: DestroyCursor — STUB: unimplemented
  (func $handle_DestroyCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 678: FindWindowW(lpClassName, lpWindowName) → HWND
  ;; Searches for a top-level window. Returns NULL (no other instances running).
  ;; Apps use this to detect if they're already running.
  (func $handle_FindWindowW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

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

  ;; 685: InSendMessage — TRUE if current message was sent by another thread via
  ;; SendMessage. Single-threaded emulator → always FALSE. stdcall, 0 args.
  (func $handle_InSendMessage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; EnumWindows(lpEnumFunc, lParam) — enumerate all top-level windows, calling
  ;; lpEnumFunc(hwnd, lParam) for each. Returns BOOL. stdcall, 2 args.
  ;;
  ;; Limitation: we don't currently chain x86 callbacks across multiple top-level
  ;; windows. In a typical single-app emulator session there's only the calling
  ;; app's own window in WND_RECORDS, and callers (e.g. screensaver "duplicate
  ;; instance" probes) interpret an empty enumeration as "no other instances" —
  ;; which is exactly the answer we want. So we report success without invoking
  ;; the callback. If a future use case needs real iteration, set up a CACA
  ;; continuation thunk that re-enters this handler to drive the next index.
  (func $handle_EnumWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; PostThreadMessageA/W(threadId, msg, wParam, lParam) — post to thread queue with hwnd=0
  ;; If target is a thread handle (0xE0000 mask), write to shared-memory XTHREAD queue
  ;; at 0xB400 (count) / 0xB410 (entries) so the target WASM instance sees it.
  ;; Otherwise fall back to the local post_queue.
  (func $handle_PostThreadMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $cnt i32)
    (if (i32.eq (i32.and (local.get $arg0) (i32.const 0xFFFF0000)) (i32.const 0x000E0000))
    (then
      (local.set $cnt (i32.load (i32.const 0xB400)))
      (if (i32.lt_u (local.get $cnt) (i32.const 32))
      (then
        (local.set $tmp (i32.add (i32.const 0xB410)
          (i32.mul (local.get $cnt) (i32.const 16))))
        (i32.store (local.get $tmp) (i32.const 0))
        (i32.store (i32.add (local.get $tmp) (i32.const 4)) (local.get $arg1))
        (i32.store (i32.add (local.get $tmp) (i32.const 8)) (local.get $arg2))
        (i32.store (i32.add (local.get $tmp) (i32.const 12)) (local.get $arg3))
        (i32.store (i32.const 0xB400) (i32.add (local.get $cnt) (i32.const 1))))))
    (else
      (if (i32.lt_u (global.get $post_queue_count) (i32.const 64))
      (then
        (local.set $tmp (i32.add (i32.const 0x400)
          (i32.mul (global.get $post_queue_count) (i32.const 16))))
        (i32.store (local.get $tmp) (i32.const 0))
        (i32.store (i32.add (local.get $tmp) (i32.const 4)) (local.get $arg1))
        (i32.store (i32.add (local.get $tmp) (i32.const 8)) (local.get $arg2))
        (i32.store (i32.add (local.get $tmp) (i32.const 12)) (local.get $arg3))
        (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1)))))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_PostThreadMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_PostThreadMessageA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 687: CreateMenu() — allocate opaque HMENU. No backing state: AppendMenu/InsertMenu
  ;; are already no-ops, menu bars render from PE RT_MENU resources, and DestroyMenu is
  ;; a return-TRUE no-op. The handle just needs to be non-zero and distinguishable so
  ;; downstream APIs that validate it won't trip.
  (func $handle_CreateMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $next_hmenu))
    (global.set $next_hmenu (i32.add (global.get $next_hmenu) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; CreatePopupMenu() — same allocator as CreateMenu.
  (func $handle_CreatePopupMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $next_hmenu))
    (global.set $next_hmenu (i32.add (global.get $next_hmenu) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; 692: ClipCursor(lprc) — we don't confine the cursor; accept and return TRUE.
  (func $handle_ClipCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 693: EnumChildWindows — STUB: unimplemented
  (func $handle_EnumChildWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 694: InvalidateRgn — STUB: unimplemented
  (func $handle_InvalidateRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 695: LoadStringW — load string resource (writes ASCII into buffer for now)
  (func $handle_LoadStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax (call $string_load_a
      (local.get $arg1)                ;; string ID
      (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
      (local.get $arg3)))              ;; max chars
    (call $pop_rsrc_ctx)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 696: CharUpperW — STUB: unimplemented
  (func $handle_CharUpperW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; CharUpperA(lpsz) — if high word is 0, uppercase the single char; else
  ;; lpsz is a pointer to a nul-terminated ANSI string uppercased in place.
  ;; Returns the input unchanged (char or pointer).
  (func $handle_CharUpperA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $c i32)
    (global.set $eax (local.get $arg0))
    (if (i32.eqz (i32.and (local.get $arg0) (i32.const 0xffff0000)))
      (then
        ;; Single-char mode: uppercase the low byte
        (local.set $c (i32.and (local.get $arg0) (i32.const 0xff)))
        (if (i32.and
              (i32.ge_u (local.get $c) (i32.const 0x61))
              (i32.le_u (local.get $c) (i32.const 0x7a)))
          (then (global.set $eax (i32.sub (local.get $c) (i32.const 0x20))))))
      (else
        (local.set $p (call $g2w (local.get $arg0)))
        (block $done (loop $lp
          (local.set $c (i32.load8_u (local.get $p)))
          (br_if $done (i32.eqz (local.get $c)))
          (if (i32.and
                (i32.ge_u (local.get $c) (i32.const 0x61))
                (i32.le_u (local.get $c) (i32.const 0x7a)))
            (then (i32.store8 (local.get $p) (i32.sub (local.get $c) (i32.const 0x20)))))
          (local.set $p (i32.add (local.get $p) (i32.const 1)))
          (br $lp)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; IME stubs — we never inject IME composition, so Immm* are no-ops.
  ;; ImmAssociateContext(hWnd, hIMC) → prev HIMC (we always return 0 — no previous)
  (func $handle_ImmAssociateContext (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ImmGetContext(hWnd) → HIMC (return 0 = no IME context)
  (func $handle_ImmGetContext (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ImmReleaseContext(hWnd, hIMC) → BOOL
  (func $handle_ImmReleaseContext (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; CharLowerA(lpsz) — mirror of CharUpperA.
  (func $handle_CharLowerA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $c i32)
    (global.set $eax (local.get $arg0))
    (if (i32.eqz (i32.and (local.get $arg0) (i32.const 0xffff0000)))
      (then
        (local.set $c (i32.and (local.get $arg0) (i32.const 0xff)))
        (if (i32.and
              (i32.ge_u (local.get $c) (i32.const 0x41))
              (i32.le_u (local.get $c) (i32.const 0x5a)))
          (then (global.set $eax (i32.add (local.get $c) (i32.const 0x20))))))
      (else
        (local.set $p (call $g2w (local.get $arg0)))
        (block $done (loop $lp
          (local.set $c (i32.load8_u (local.get $p)))
          (br_if $done (i32.eqz (local.get $c)))
          (if (i32.and
                (i32.ge_u (local.get $c) (i32.const 0x41))
                (i32.le_u (local.get $c) (i32.const 0x5a)))
            (then (i32.store8 (local.get $p) (i32.add (local.get $c) (i32.const 0x20)))))
          (local.set $p (i32.add (local.get $p) (i32.const 1)))
          (br $lp)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; OemToCharA(lpSrc, lpDst) — for US codepage, OEM ≡ ANSI; strcpy.
  (func $handle_OemToCharA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $dst i32) (local $c i32)
    (local.set $src (call $g2w (local.get $arg0)))
    (local.set $dst (call $g2w (local.get $arg1)))
    (block $done (loop $lp
      (local.set $c (i32.load8_u (local.get $src)))
      (i32.store8 (local.get $dst) (local.get $c))
      (br_if $done (i32.eqz (local.get $c)))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 1)))
      (br $lp)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; ============================================================
  ;; COMCTL32 Common Controls handlers
  ;; ============================================================

  ;; InitCommonControls() — 0 args, void return, registers common control window classes
  (func $handle_InitCommonControls (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; No-op: our window creation handles class names directly
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; ImageList_Create(cx, cy, flags, cInitial, cGrow) — 5 args, returns HIMAGELIST handle
  (func $handle_ImageList_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    ;; Allocate a small struct to track the image list: [cx, cy, flags, count]
    (local.set $buf (call $heap_alloc (i32.const 16)))
    (i32.store (call $g2w (local.get $buf)) (local.get $arg0))           ;; cx
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 4))) (local.get $arg1))  ;; cy
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 8))) (local.get $arg2))  ;; flags
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 12))) (i32.const 0))     ;; count=0
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; ImageList_Destroy(himl) — 1 arg, returns BOOL
  (func $handle_ImageList_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Free not implemented yet, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ImageList_LoadImageA(hi, lpbmp, cx, cGrow, crMask, uType, uFlags) — 7 args
  (func $handle_ImageList_LoadImageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    ;; Create an empty image list — real bitmap loading would need host support
    ;; arg2=cx (icon width), return a valid HIMAGELIST
    (local.set $buf (call $heap_alloc (i32.const 16)))
    (i32.store (call $g2w (local.get $buf)) (local.get $arg2))           ;; cx
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 4))) (local.get $arg2))  ;; cy=cx
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 8))) (i32.const 0))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 12))) (i32.const 0))
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
  )

  ;; ImageList_LoadImageW — same as A, 7 args
  (func $handle_ImageList_LoadImageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    (local.set $buf (call $heap_alloc (i32.const 16)))
    (i32.store (call $g2w (local.get $buf)) (local.get $arg2))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 4))) (local.get $arg2))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 8))) (i32.const 0))
    (i32.store (call $g2w (i32.add (local.get $buf) (i32.const 12))) (i32.const 0))
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; CreateStatusWindowA(style, lpszText, hwndParent, wID) — 4 args, returns HWND
  (func $handle_CreateStatusWindowA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Create a status bar window via CreateWindowExA with "msctls_statusbar32" class
    ;; For now, return a valid hwnd via host_create_window
    (global.set $eax (call $host_create_window
      (i32.add (global.get $next_hwnd) (i32.const 0))  ;; hwnd
      (local.get $arg0)   ;; style
      (i32.const 0)       ;; x
      (i32.const 0)       ;; y
      (i32.const 0)       ;; cx (auto-size)
      (i32.const 20)      ;; cy (typical status bar height)
      (call $g2w (local.get $arg1))  ;; text ptr
      (local.get $arg3))) ;; wID as menu
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; CreateToolbarEx — 13 args, returns HWND of toolbar
  (func $handle_CreateToolbarEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateToolbarEx(hwndParent, ws, wID, nBitmaps, hBMInst, wBMID, lpButtons, iNumButtons, dxButton, dyButton, dxBitmap, dyBitmap, uStructSize)
    ;; Return a valid hwnd
    (global.set $eax (call $host_create_window
      (global.get $next_hwnd)
      (local.get $arg1)   ;; style
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 28) ;; typical toolbar height
      (i32.const 0) ;; no text
      (local.get $arg2))) ;; wID
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 56)))  ;; stdcall, 13 args
  )

  ;; CreateUpDownControl — 12 args, returns HWND
  (func $handle_CreateUpDownControl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateUpDownControl(dwStyle, x, y, cx, cy, hParent, nID, hInst, hBuddy, nUpper, nLower, nPos)
    (global.set $eax (call $host_create_window
      (global.get $next_hwnd)
      (local.get $arg0) ;; style
      (local.get $arg1) ;; x
      (local.get $arg2) ;; y
      (local.get $arg3) ;; cx
      (local.get $arg4) ;; cy
      (i32.const 0) ;; no text
      (i32.const 0)))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52)))  ;; stdcall, 12 args
  )

  ;; GetEffectiveClientRect(hWnd, lprc, lpInfo) — 3 args, void
  (func $handle_GetEffectiveClientRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Calculates the client rect excluding toolbars/status bars
    ;; For now, just call GetClientRect equivalent — fill rect with window client area
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (local.get $wa) (i32.const 0))          ;; left
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))  ;; top
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 640))  ;; right
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 480)) ;; bottom
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DrawStatusTextA(hDC, lprc, pszText, uFlags) — 4 args, void
  (func $handle_DrawStatusTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Draw text in a status bar style rect — delegate to host TextOut
    (if (local.get $arg2)
      (then
        (call $host_draw_text
          (local.get $arg0) ;; hDC
          (call $g2w (local.get $arg2)) ;; text
          (i32.const -1) ;; nCount=-1 (null terminated)
          (call $g2w (local.get $arg1)) ;; lpRect
          (i32.const 0)))) ;; flags
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; DrawStatusTextW — 4 args, void (same but wide)
  (func $handle_DrawStatusTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Wide version — for now just skip the draw
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; MenuHelp(uMsg, wParam, lParam, hMainMenu, hInst) — 5 args, void
  (func $handle_MenuHelp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Processes WM_MENUSELECT and WM_COMMAND for status bar help text — no-op
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; ShowHideMenuCtl(hWnd, uFlags, lpInfo) — 3 args, returns BOOL
  (func $handle_ShowHideMenuCtl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; CreateMappedBitmap(hInstance, idBitmap, wFlags, lpColorMap, iNumMaps) — 5 args, returns HBITMAP
  (func $handle_CreateMappedBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return a valid bitmap handle
    (global.set $eax (i32.const 0x30002))  ;; fake bitmap handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; CreatePropertySheetPageA(lppsp) — 1 arg, returns HPROPSHEETPAGE
  (func $handle_CreatePropertySheetPageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return a fake handle
    (local.set $arg0 (call $heap_alloc (i32.const 4)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; PropertySheetA(lppsph) — 1 arg, returns int (>0 if user clicked OK)
  (func $handle_PropertySheetA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return 0 (user cancelled / no change)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ImageList_SetBkColor(himl, clrBk) — 2 args, returns old bk color
  (func $handle_ImageList_SetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $old i32)
    (local.set $old (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 8))) (local.get $arg1))
    (global.set $eax (local.get $old))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ImageList_GetBkColor(himl) — 1 arg
  (func $handle_ImageList_GetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CreateStatusWindowW — same as A version, 4 args
  (func $handle_CreateStatusWindowW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_create_window
      (global.get $next_hwnd)
      (local.get $arg0)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 20)
      (i32.const 0) (local.get $arg3)))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; ============================================================
  ;; COMCTL32 internal heap functions (ordinal-only)
  ;; ============================================================

  ;; Comctl32_Alloc(dwSize) — 1 arg, returns pointer (zeroed)
  (func $handle_Comctl32_Alloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32)
    (local.set $ptr (call $heap_alloc (local.get $arg0)))
    ;; Zero the allocation
    (if (local.get $arg0)
      (then (memory.fill (call $g2w (local.get $ptr)) (i32.const 0) (local.get $arg0))))
    (global.set $eax (local.get $ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; Comctl32_ReAlloc(pv, cbNew) — 2 args, returns pointer
  (func $handle_Comctl32_ReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Simple: allocate new, copy, return new (no free of old — heap doesn't support free yet)
    (local $new_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then
        ;; NULL input = just alloc
        (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
        (if (local.get $arg1)
          (then (memory.fill (call $g2w (local.get $new_ptr)) (i32.const 0) (local.get $arg1)))))
      (else
        ;; Realloc: alloc new, copy old data
        (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
        (if (local.get $arg1)
          (then (memory.copy (call $g2w (local.get $new_ptr)) (call $g2w (local.get $arg0)) (local.get $arg1))))))
    (global.set $eax (local.get $new_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; Comctl32_Free(pv) — 1 arg, returns BOOL
  (func $handle_Comctl32_Free (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Our heap doesn't support free, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; Comctl32_GetSize(pv) — 1 arg, returns DWORD size
  (func $handle_Comctl32_GetSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Our heap doesn't track sizes, return a reasonable default
    (global.set $eax (i32.const 256))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ============================================================
  ;; DSA (Dynamic Structure Array) — real implementation
  ;; DSA layout in memory: [item_size:4, count:4, capacity:4, data_ptr:4]
  ;; ============================================================

  ;; DSA_Create(cbItem, cItemGrow) — 2 args, returns HDSA
  (func $handle_DSA_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dsa i32)
    (local $cap i32)
    (local.set $cap (select (local.get $arg1) (i32.const 8) (i32.gt_u (local.get $arg1) (i32.const 0))))
    (local.set $dsa (call $heap_alloc (i32.const 16)))
    (i32.store (call $g2w (local.get $dsa)) (local.get $arg0))           ;; item_size
    (i32.store (call $g2w (i32.add (local.get $dsa) (i32.const 4))) (i32.const 0))  ;; count
    (i32.store (call $g2w (i32.add (local.get $dsa) (i32.const 8))) (local.get $cap))  ;; capacity
    ;; Allocate data buffer: capacity * item_size
    (i32.store (call $g2w (i32.add (local.get $dsa) (i32.const 12)))
      (call $heap_alloc (i32.mul (local.get $cap) (local.get $arg0))))
    (global.set $eax (local.get $dsa))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DSA_Destroy(hdsa) — 1 arg, returns BOOL
  (func $handle_DSA_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Can't free, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DSA_GetItem(hdsa, index, pitem) — 3 args, returns BOOL
  (func $handle_DSA_GetItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32)
    (local $data_ptr i32)
    (local $count i32)
    (local.set $item_size (i32.load (call $g2w (local.get $arg0))))
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $data_ptr (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 12)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        ;; Copy item_size bytes from data[index*item_size] to pitem
        (memory.copy (call $g2w (local.get $arg2))
          (call $g2w (i32.add (local.get $data_ptr) (i32.mul (local.get $arg1) (local.get $item_size))))
          (local.get $item_size))
        (global.set $eax (i32.const 1)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DSA_GetItemPtr(hdsa, index) — 2 args, returns pointer to item
  (func $handle_DSA_GetItemPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32)
    (local $data_ptr i32)
    (local $count i32)
    (local.set $item_size (i32.load (call $g2w (local.get $arg0))))
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $data_ptr (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 12)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (global.set $eax (i32.add (local.get $data_ptr) (i32.mul (local.get $arg1) (local.get $item_size)))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DSA_InsertItem(hdsa, index, pitem) — 3 args, returns index or -1
  (func $handle_DSA_InsertItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32)
    (local $count i32)
    (local $data_ptr i32)
    (local $idx i32)
    (local.set $item_size (i32.load (call $g2w (local.get $arg0))))
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (local.set $data_ptr (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 12)))))
    ;; Clamp index: if index > count or DA_LAST (0x7FFFFFFF), append
    (local.set $idx (select (local.get $count) (local.get $arg1)
      (i32.gt_u (local.get $arg1) (local.get $count))))
    ;; Copy item data to data[idx * item_size]
    (memory.copy
      (call $g2w (i32.add (local.get $data_ptr) (i32.mul (local.get $idx) (local.get $item_size))))
      (call $g2w (local.get $arg2))
      (local.get $item_size))
    ;; Increment count
    (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 4)))
      (i32.add (local.get $count) (i32.const 1)))
    (global.set $eax (local.get $idx))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DSA_DeleteItem(hdsa, index) — 2 args, returns BOOL
  (func $handle_DSA_DeleteItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local.set $count (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 4)))))
    (if (i32.and (i32.lt_u (local.get $arg1) (local.get $count)) (i32.gt_u (local.get $count) (i32.const 0)))
      (then
        ;; Decrement count (simplified — doesn't shift items, but works for stack-like usage)
        (i32.store (call $g2w (i32.add (local.get $arg0) (i32.const 4)))
          (i32.sub (local.get $count) (i32.const 1)))
        (global.set $eax (i32.const 1)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ============================================================
  ;; DPA (Dynamic Pointer Array) — real implementation
  ;; DPA layout: [count:4, capacity:4, ptrs_ptr:4]
  ;; ============================================================

  ;; DPA_Create(cItemGrow) — 1 arg, returns HDPA
  (func $handle_DPA_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dpa i32)
    (local $cap i32)
    (local.set $cap (select (local.get $arg0) (i32.const 8) (i32.gt_u (local.get $arg0) (i32.const 0))))
    (local.set $dpa (call $heap_alloc (i32.const 12)))
    (i32.store (call $g2w (local.get $dpa)) (i32.const 0))           ;; count
    (i32.store (call $g2w (i32.add (local.get $dpa) (i32.const 4))) (local.get $cap))  ;; capacity
    (i32.store (call $g2w (i32.add (local.get $dpa) (i32.const 8)))
      (call $heap_alloc (i32.shl (local.get $cap) (i32.const 2))))   ;; ptrs array
    (global.set $eax (local.get $dpa))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DPA_Destroy(hdpa) — 1 arg, returns BOOL
  (func $handle_DPA_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DPA_GetPtr(hdpa, index) — 2 args, returns pointer at index
  (func $handle_DPA_GetPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $ptrs i32)
    (local.set $count (i32.load (call $g2w (local.get $arg0))))
    (local.set $ptrs (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (global.set $eax (i32.load (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $arg1) (i32.const 2)))))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DPA_InsertPtr(hdpa, index, p) — 3 args, returns index or -1
  (func $handle_DPA_InsertPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $ptrs i32)
    (local $idx i32)
    (local.set $count (i32.load (call $g2w (local.get $arg0))))
    (local.set $ptrs (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (local.set $idx (select (local.get $count) (local.get $arg1)
      (i32.gt_u (local.get $arg1) (local.get $count))))
    ;; Store pointer at ptrs[idx]
    (i32.store (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $idx) (i32.const 2))))
      (local.get $arg2))
    ;; Increment count
    (i32.store (call $g2w (local.get $arg0)) (i32.add (local.get $count) (i32.const 1)))
    (global.set $eax (local.get $idx))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DPA_DeletePtr(hdpa, index) — 2 args, returns removed pointer
  (func $handle_DPA_DeletePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $ptrs i32)
    (local $removed i32)
    (local.set $count (i32.load (call $g2w (local.get $arg0))))
    (local.set $ptrs (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (local.set $removed (i32.load (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $arg1) (i32.const 2))))))
        (i32.store (call $g2w (local.get $arg0)) (i32.sub (local.get $count) (i32.const 1)))
        (global.set $eax (local.get $removed)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DPA_DeleteAllPtrs(hdpa) — 1 arg, returns BOOL
  (func $handle_DPA_DeleteAllPtrs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Set count to 0
    (i32.store (call $g2w (local.get $arg0)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; StrToIntA(lpSrc) — 1 arg, returns integer value
  (func $handle_StrToIntA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32) (local $result i32) (local $neg i32) (local $ch i32)
    (local.set $ptr (call $g2w (local.get $arg0)))
    (local.set $result (i32.const 0))
    (local.set $neg (i32.const 0))
    ;; Skip leading whitespace
    (block $ws_done (loop $ws
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $ws_done (i32.ne (local.get $ch) (i32.const 0x20))) ;; space
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $ws)))
    ;; Check for sign
    (if (i32.eq (i32.load8_u (local.get $ptr)) (i32.const 0x2D)) ;; '-'
      (then (local.set $neg (i32.const 1))
            (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))))
    (if (i32.eq (i32.load8_u (local.get $ptr)) (i32.const 0x2B)) ;; '+'
      (then (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))))
    ;; Parse digits
    (block $done (loop $digits
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $done (i32.lt_u (local.get $ch) (i32.const 0x30)))
      (br_if $done (i32.gt_u (local.get $ch) (i32.const 0x39)))
      (local.set $result (i32.add (i32.mul (local.get $result) (i32.const 10))
        (i32.sub (local.get $ch) (i32.const 0x30))))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $digits)))
    (if (local.get $neg)
      (then (local.set $result (i32.sub (i32.const 0) (local.get $result)))))
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 926: socket(af, type, protocol) — 3 args stdcall
  ;; Return INVALID_SOCKET (-1) — no networking
  (func $handle_socket (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 927: closesocket(s) — 1 arg stdcall
  (func $handle_closesocket (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 928: connect(s, name, namelen) — 3 args stdcall, return SOCKET_ERROR (-1)
  (func $handle_connect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 929: send(s, buf, len, flags) — 4 args stdcall, return SOCKET_ERROR (-1)
  (func $handle_send (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 930: recv(s, buf, len, flags) — 4 args stdcall, return SOCKET_ERROR (-1)
  (func $handle_recv (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 931: gethostbyname(name) — 1 arg stdcall, return NULL (lookup failed)
  (func $handle_gethostbyname (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 932: htons(hostshort) — 1 arg stdcall, byte-swap 16-bit
  (func $handle_htons (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.or
      (i32.shl (i32.and (local.get $arg0) (i32.const 0xFF)) (i32.const 8))
      (i32.and (i32.shr_u (local.get $arg0) (i32.const 8)) (i32.const 0xFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 933: inet_addr(cp) — 1 arg stdcall, return INADDR_NONE (-1)
  (func $handle_inet_addr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 934: select(nfds, readfds, writefds, exceptfds, timeout) — 5 args stdcall
  (func $handle_select (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))  ;; 0 = timeout, no ready sockets
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 935: setsockopt(s, level, optname, optval, optlen) — 5 args stdcall
  (func $handle_setsockopt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 936: ioctlsocket(s, cmd, argp) — 3 args stdcall
  (func $handle_ioctlsocket (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const -1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 923: WSAStartup(wVersionRequested, lpWSAData) — 2 args stdcall
  ;; Fill WSADATA struct with version 2.2, return 0 (success)
  (func $handle_WSAStartup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; WSADATA: wVersion(2), wHighVersion(2), rest is description strings + status
    (i32.store16 (local.get $wa) (i32.const 0x0202))         ;; wVersion = 2.2
    (i32.store16 (i32.add (local.get $wa) (i32.const 2)) (i32.const 0x0202)) ;; wHighVersion = 2.2
    (global.set $eax (i32.const 0))  ;; success
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 924: WSACleanup() — 0 args stdcall
  (func $handle_WSACleanup (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 925: WSAGetLastError() — 0 args stdcall
  (func $handle_WSAGetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 921: SetWindowRgn(hwnd, hRgn, bRedraw) — 3 args stdcall
  (func $handle_SetWindowRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_gdi_set_window_rgn
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 922: GetWindowRgn(hwnd, hRgn) — 2 args stdcall, return ERROR (0)
  (func $handle_GetWindowRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 918: MonitorFromRect(lprc, dwFlags) — 2 args stdcall
  ;; Return fake monitor handle 0x00010000 (single monitor)
  (func $handle_MonitorFromRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00010000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 919: GetMonitorInfoA(hMonitor, lpmi) — 2 args stdcall
  ;; Fill MONITORINFO with 640x480 desktop
  (func $handle_GetMonitorInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; MONITORINFO: cbSize(4), rcMonitor(16), rcWork(16), dwFlags(4) = 40 bytes
    ;; rcMonitor: left=0, top=0, right=640, bottom=480
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))   ;; left
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0))   ;; top
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 640)) ;; right
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.const 480)) ;; bottom
    ;; rcWork: same as rcMonitor
    (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 0))
    (i32.store (i32.add (local.get $wa) (i32.const 24)) (i32.const 0))
    (i32.store (i32.add (local.get $wa) (i32.const 28)) (i32.const 640))
    (i32.store (i32.add (local.get $wa) (i32.const 32)) (i32.const 480))
    ;; dwFlags: MONITORINFOF_PRIMARY = 1
    (i32.store (i32.add (local.get $wa) (i32.const 36)) (i32.const 1))
    (global.set $eax (i32.const 1))  ;; success
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 920: MonitorFromWindow(hwnd, dwFlags) — 2 args stdcall
  (func $handle_MonitorFromWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00010000))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; MonitorFromPoint(pt.x, pt.y, dwFlags) — POINT passed by value (2 dwords) + dwFlags = 3 args stdcall
  (func $handle_MonitorFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00010000))  ;; same fake monitor handle as MonitorFromRect
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; GetPrivateProfileStructA(appName, keyName, lpStruct, nSize, fileName) — 5 args stdcall
  (func $handle_GetPrivateProfileStructA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return 0 (failure) — struct not found in INI
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 917: CoCreateGuid(pguid) — 1 arg stdcall
  ;; Write a deterministic GUID based on a counter, return S_OK
  (func $handle_CoCreateGuid (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg0)))
    (global.set $guid_counter (i32.add (global.get $guid_counter) (i32.const 1)))
    (i32.store (local.get $wa) (global.get $guid_counter))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x0000CAFE))
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0xDEAD0040))
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0xBEEF0000))
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 916: RasEnumConnectionsA(lpRasConn, lpcb, lpcConnections) — 3 args stdcall
  ;; Return 0 (SUCCESS) with *lpcConnections = 0 (no dial-up connections)
  (func $handle_RasEnumConnectionsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (i32.store (call $g2w (local.get $arg2)) (i32.const 0)) ;; *lpcConnections = 0
    (global.set $eax (i32.const 0))  ;; SUCCESS
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 941: GetClassLongA(hwnd, nIndex) — 2 args stdcall
  ;; GCL_HICON=-14, GCL_HICONSM=-34, GCL_HCURSOR=-12, GCL_HBRBACKGROUND=-10
  ;; GCL_STYLE=-26, GCL_WNDPROC=-24, GCL_CBWNDEXTRA=-18, GCL_CBCLSEXTRA=-20
  (func $handle_GetClassLongA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return 0 for most indices — we don't track per-class data
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 942: CopyIcon(hIcon) — 1 arg stdcall, return same handle (no real copy needed)
  (func $handle_CopyIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 953: PrintDlgA(lppd) — show placeholder modal dialog
  (func $handle_PrintDlgA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_stub_dialog (local.get $dlg) (local.get $owner) (i32.const 0x24C))   ;; "Print"
    (call $modal_begin (local.get $dlg) (i32.const 8)))

  ;; 954: CoFreeUnusedLibraries() — no args, no-op
  (func $handle_CoFreeUnusedLibraries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 952: CoRevokeClassObject(dwRegister) — 1 arg stdcall, return S_OK
  (func $handle_CoRevokeClassObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 951: CoRegisterClassObject(rclsid, pUnk, dwClsContext, flags, lpdwRegister)
  ;; 5 args stdcall. Write a fake registration cookie, return S_OK.
  (func $handle_CoRegisterClassObject (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg4)
      (then (call $gs32 (local.get $arg4) (i32.const 0xC0010001))))
    (global.set $eax (i32.const 0))  ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 950: DrawFrameControl(hdc, lprc, uType, uState) — 4 args stdcall
  ;; Draw the frame as a raised edge (BDR_RAISEDOUTER|BDR_RAISEDINNER=5, BF_RECT=15)
  (func $handle_DrawFrameControl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rc i32)
    (local.set $rc (call $g2w (local.get $arg1)))
    (drop (call $host_gdi_draw_edge
      (local.get $arg0)
      (i32.load (local.get $rc))
      (i32.load offset=4 (local.get $rc))
      (i32.load offset=8 (local.get $rc))
      (i32.load offset=12 (local.get $rc))
      (i32.const 5)    ;; EDGE_RAISED
      (i32.const 15))) ;; BF_RECT
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 949: ExtTextOutA(hdc, x, y, options, lprect, lpString, c, lpDx) — 8 args stdcall
  ;; Delegates to TextOut, ignoring clipping/spacing.
  (func $handle_ExtTextOutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lpString i32) (local $count i32)
    (local.set $lpString (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; arg5
    (local.set $count (call $gl32 (i32.add (global.get $esp) (i32.const 28))))    ;; arg6
    (global.set $eax (call $host_gdi_text_out
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (call $g2w (local.get $lpString)) (local.get $count) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))) ;; 8 args + ret
  )

  ;; 948: RegEnumKeyA(hKey, dwIndex, lpName, cchName) — 4 args stdcall
  (func $handle_RegEnumKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_enum_key
      (local.get $arg0)                    ;; hKey
      (local.get $arg1)                    ;; dwIndex
      (call $g2w (local.get $arg2))        ;; lpName → WASM ptr
      (local.get $arg3)                    ;; cchName
      (i32.const 0)))                      ;; isWide = false
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 947: SetPixelV(hdc, x, y, color) — 4 args stdcall, like SetPixel but returns BOOL
  (func $handle_SetPixelV (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_gdi_set_pixel (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 946: CopyImage(hImage, uType, cx, cy, flags) — 5 args stdcall, return same handle
  (func $handle_CopyImage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 945: CreateIconIndirect(piconinfo) — 1 arg stdcall, return fake icon handle
  (func $handle_CreateIconIndirect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00CC0001))  ;; fake icon handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 944: DrawIconEx(hdc, x, y, hIcon, cx, cy, istep, hbrFlicker, diFlags) — 9 args stdcall
  ;; Return TRUE, no-op for now (icon drawing delegated to renderer)
  (func $handle_DrawIconEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))  ;; 9 args + ret
  )

  ;; 943: GetIconInfo(hIcon, piconinfo) — 2 args stdcall
  ;; ICONINFO: fIcon(4), xHotspot(4), yHotspot(4), hbmMask(4), hbmColor(4)
  (func $handle_GetIconInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32)
    (local.set $ptr (call $g2w (local.get $arg1)))
    (i32.store (local.get $ptr) (i32.const 1))           ;; fIcon = TRUE (it's an icon)
    (i32.store offset=4 (local.get $ptr) (i32.const 0))  ;; xHotspot
    (i32.store offset=8 (local.get $ptr) (i32.const 0))  ;; yHotspot
    (i32.store offset=12 (local.get $ptr) (i32.const 0)) ;; hbmMask = NULL
    (i32.store offset=16 (local.get $ptr) (i32.const 0)) ;; hbmColor = NULL
    (global.set $eax (i32.const 1))  ;; success
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 957: ChooseColorA(lpcc) — show the WAT-driven Color picker with a
  ;; basic-colors swatch grid. On OK, writes chosen COLORREF into
  ;; CHOOSECOLOR.rgbResult at +0x0C.
  (func $handle_ChooseColorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_color_dialog (local.get $dlg) (local.get $owner) (local.get $arg0))
    (call $modal_begin (local.get $dlg) (i32.const 8)))

  ;; === VERSION.DLL APIs ===

  ;; GetFileVersionInfoSizeA(lptstrFilename, lpdwHandle) → size or 0
  ;; Finds RT_VERSION (16) resource ID 1 in the loaded PE and returns its size.
  (func $handle_GetFileVersionInfoSizeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $size i32)
    ;; If lpdwHandle is non-null, set *lpdwHandle = 0
    (if (local.get $arg1)
      (then (call $gs32 (call $g2w (local.get $arg1)) (i32.const 0))))
    ;; Find RT_VERSION (16) resource with ID 1
    (local.set $entry (call $find_resource (i32.const 16) (i32.const 1)))
    (if (local.get $entry)
      (then
        ;; entry points to data entry: +0=RVA, +4=size
        (local.set $size (call $gl32 (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $entry) (i32.const 4))))))
        (global.set $eax (local.get $size)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetFileVersionInfoA(lptstrFilename, dwHandle, dwLen, lpData) → BOOL
  ;; Copies the RT_VERSION resource data into the caller's buffer.
  (func $handle_GetFileVersionInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rva i32) (local $size i32) (local $len i32)
    ;; Find RT_VERSION (16) resource with ID 1
    (local.set $entry (call $find_resource (i32.const 16) (i32.const 1)))
    (if (i32.eqz (local.get $entry))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $rva (call $gl32 (call $g2w (i32.add (global.get $image_base) (local.get $entry)))))
    (local.set $size (call $gl32 (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $entry) (i32.const 4))))))
    ;; Copy min(dwLen, size) bytes from resource to lpData
    (local.set $len (local.get $arg2))
    (if (i32.gt_u (local.get $len) (local.get $size))
      (then (local.set $len (local.get $size))))
    (memory.copy
      (call $g2w (local.get $arg3))
      (call $g2w (i32.add (global.get $image_base) (local.get $rva)))
      (local.get $len))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; VerQueryValueA(pBlock, lpSubBlock, lplpBuffer, puLen) → BOOL
  ;; Only handles "\" (root query) — returns pointer to VS_FIXEDFILEINFO.
  (func $handle_VerQueryValueA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $block_wa i32) (local $sub_wa i32)
    (local.set $block_wa (call $g2w (local.get $arg0)))
    (local.set $sub_wa (call $g2w (local.get $arg1)))
    ;; Check if lpSubBlock == "\" and VS_FIXEDFILEINFO signature matches
    ;; VS_FIXEDFILEINFO is at offset 0x28 in VS_VERSIONINFO
    ;; (6 byte header + 32 byte UTF-16 key "VS_VERSION_INFO\0" + 2 byte padding)
    (if (i32.and
          (i32.and
            (i32.eq (i32.load8_u (local.get $sub_wa)) (i32.const 0x5c))
            (i32.eqz (i32.load8_u (i32.add (local.get $sub_wa) (i32.const 1)))))
          (i32.eq (i32.load (i32.add (local.get $block_wa) (i32.const 0x28)))
                  (i32.const -17825603)))  ;; 0xFEEF04BD
      (then
        ;; Set *lplpBuffer = guest ptr to VS_FIXEDFILEINFO
        (call $gs32 (call $g2w (local.get $arg2))
          (i32.add (local.get $arg0) (i32.const 0x28)))
        ;; Set *puLen = sizeof(VS_FIXEDFILEINFO) = 52
        (call $gs32 (call $g2w (local.get $arg3)) (i32.const 52))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; For any other sub-block or if signature doesn't match, return FALSE
    (if (local.get $arg3)
      (then (call $gs32 (call $g2w (local.get $arg3)) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

