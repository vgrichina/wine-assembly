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
    (global.set $tick_count (call $host_get_ticks))
    (local.set $free_slot (i32.const -1))
    (local.set $i (i32.const 0))
    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (global.get $TIMER_MAX)))
        (local.set $addr (i32.add (global.get $TIMER_TABLE) (i32.mul (local.get $i) (global.get $TIMER_ENTRY_SIZE))))
        ;; Check if this slot matches (same hwnd + id) — update in place.
        ;; hwnd may legitimately be NULL for callback timers; id=0 marks empty.
        (if (i32.and
              (i32.ne (i32.load (i32.add (local.get $addr) (i32.const 4))) (i32.const 0))
              (i32.and
                (i32.eq (i32.load (local.get $addr)) (local.get $hwnd))
                (i32.eq (i32.load (i32.add (local.get $addr) (i32.const 4))) (local.get $id))))
          (then
            (i32.store (i32.add (local.get $addr) (i32.const 8)) (local.get $interval))
            (i32.store (i32.add (local.get $addr) (i32.const 12)) (global.get $tick_count))
            (i32.store (i32.add (local.get $addr) (i32.const 16)) (local.get $callback))
            (return)
          )
        )
        ;; Track first free slot (id=0 means empty)
        (if (i32.and
              (i32.eq (local.get $free_slot) (i32.const -1))
              (i32.eqz (i32.load (i32.add (local.get $addr) (i32.const 4)))))
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
            ;; Clear the slot (id=0 means empty; hwnd may legitimately be NULL)
            (i32.store (local.get $addr) (i32.const 0))
            (i32.store (i32.add (local.get $addr) (i32.const 4)) (i32.const 0))
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

  ;; Real USER tears down HWND-owned timers when the window is destroyed.
  ;; Without this, timer-driven child pages can keep sending WM_TIMER after
  ;; their HWND has gone away and continue drawing through cached parent DCs.
  (func $timer_kill_hwnd (param $hwnd i32)
    (local $i i32)
    (local $addr i32)
    (local.set $i (i32.const 0))
    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (global.get $TIMER_MAX)))
        (local.set $addr (i32.add (global.get $TIMER_TABLE) (i32.mul (local.get $i) (global.get $TIMER_ENTRY_SIZE))))
        (if (i32.and
              (i32.eq (i32.load (local.get $addr)) (local.get $hwnd))
              (i32.ne (i32.load (i32.add (local.get $addr) (i32.const 4))) (i32.const 0)))
          (then
            (i32.store (local.get $addr) (i32.const 0))
            (i32.store (i32.add (local.get $addr) (i32.const 4)) (i32.const 0))
            (global.set $timer_count (i32.sub (global.get $timer_count) (i32.const 1)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop))))

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
        ;; Skip empty slots (id=0 means empty; hwnd may legitimately be NULL)
        (if (i32.load (i32.add (local.get $addr) (i32.const 4)))
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

  ;; Shared cross-instance posted-message queue.
  ;; Worker threads run in separate WASM instances, so globals such as
  ;; $post_queue_count are private. Win98 USER queues are shared by the window
  ;; owner thread; use shared linear memory for messages posted by worker
  ;; instances so the main UI pump can see them.
  (func $shared_post_queue_enqueue (param $hwnd i32) (param $msg i32) (param $wparam i32) (param $lparam i32) (result i32)
    (local $cnt i32) (local $slot i32)
    (local.set $cnt (i32.load (i32.const 0xB400)))
    (if (i32.ge_u (local.get $cnt) (i32.const 64))
      (then (return (i32.const 0))))
    (local.set $slot (i32.add (i32.const 0xB410)
      (i32.mul (local.get $cnt) (i32.const 16))))
    (i32.store          (local.get $slot) (local.get $hwnd))
    (i32.store offset=4 (local.get $slot) (local.get $msg))
    (i32.store offset=8 (local.get $slot) (local.get $wparam))
    (i32.store offset=12 (local.get $slot) (local.get $lparam))
    (i32.store (i32.const 0xB400) (i32.add (local.get $cnt) (i32.const 1)))
    (i32.const 1)
  )

  (func $shared_post_queue_read (param $msg_ptr i32) (param $remove i32) (result i32)
    (local $cnt i32)
    (local.set $cnt (i32.load (i32.const 0xB400)))
    (if (i32.eqz (local.get $cnt))
      (then (return (i32.const 0))))
    (call $gs32 (local.get $msg_ptr) (i32.load (i32.const 0xB410)))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.load (i32.const 0xB414)))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.load (i32.const 0xB418)))
    (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.load (i32.const 0xB41C)))
    (if (local.get $remove)
      (then
        (i32.store (i32.const 0xB400) (i32.sub (local.get $cnt) (i32.const 1)))
        (if (i32.gt_u (local.get $cnt) (i32.const 1))
          (then (call $memcpy (i32.const 0xB410) (i32.const 0xB420)
            (i32.mul (i32.sub (local.get $cnt) (i32.const 1)) (i32.const 16)))))))
    (i32.const 1)
  )

  ;; 0: ExitProcess
  (func $handle_ExitProcess (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (call $host_exit (local.get $arg0)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)
  )

  ;; Statically dispatched system DLLs do not have a mapped PE image or DLL
  ;; table entry. Recognize OLE32 explicitly so callers can use its handle with
  ;; GetProcAddress, which already resolves non-mapped modules through the API
  ;; table. Accept both the basename and the conventional .DLL suffix.
  (func $guest_name_is_ole32 (param $name i32) (result i32)
    (local $p i32)
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (local.set $p (call $g2w (local.get $name)))
    (if (i32.ne (i32.or (i32.load8_u (local.get $p)) (i32.const 0x20)) (i32.const 0x6f)) (then (return (i32.const 0)))) ;; o
    (if (i32.ne (i32.or (i32.load8_u (i32.add (local.get $p) (i32.const 1))) (i32.const 0x20)) (i32.const 0x6c)) (then (return (i32.const 0)))) ;; l
    (if (i32.ne (i32.or (i32.load8_u (i32.add (local.get $p) (i32.const 2))) (i32.const 0x20)) (i32.const 0x65)) (then (return (i32.const 0)))) ;; e
    (if (i32.ne (i32.load8_u (i32.add (local.get $p) (i32.const 3))) (i32.const 0x33)) (then (return (i32.const 0)))) ;; 3
    (if (i32.ne (i32.load8_u (i32.add (local.get $p) (i32.const 4))) (i32.const 0x32)) (then (return (i32.const 0)))) ;; 2
    (if (i32.eqz (i32.load8_u (i32.add (local.get $p) (i32.const 5)))) (then (return (i32.const 1))))
    (if (i32.ne (i32.load8_u (i32.add (local.get $p) (i32.const 5))) (i32.const 0x2e)) (then (return (i32.const 0)))) ;; .
    (if (i32.ne (i32.or (i32.load8_u (i32.add (local.get $p) (i32.const 6))) (i32.const 0x20)) (i32.const 0x64)) (then (return (i32.const 0)))) ;; d
    (if (i32.ne (i32.or (i32.load8_u (i32.add (local.get $p) (i32.const 7))) (i32.const 0x20)) (i32.const 0x6c)) (then (return (i32.const 0)))) ;; l
    (if (i32.ne (i32.or (i32.load8_u (i32.add (local.get $p) (i32.const 8))) (i32.const 0x20)) (i32.const 0x6c)) (then (return (i32.const 0)))) ;; l
    (i32.eqz (i32.load8_u (i32.add (local.get $p) (i32.const 9))))
  )

  ;; 1: GetModuleHandleA(lpModuleName) — NULL→image_base, else search DLL table
  (func $handle_GetModuleHandleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32) (local $idx i32)
    (if (i32.eqz (local.get $arg0))
      (then (local.set $result (global.get $image_base)))
      (else
        (if (call $guest_name_is_ole32 (local.get $arg0))
          (then (local.set $result (global.get $image_base)))
          (else
            (local.set $idx (call $find_loaded_dll (local.get $arg0)))
            (if (i32.ge_s (local.get $idx) (i32.const 0))
              (then
                (local.set $result
                  (i32.load (i32.add (global.get $DLL_TABLE)
                    (i32.mul (local.get $idx) (i32.const 32))))))
              (else (local.set $result (i32.const 0))))))))
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
    ;; Check if hModule matches a loaded DLL — if so, resolve from its export table.
    ;; lpProcName may be a MAKEINTRESOURCE ordinal (< 0x10000) rather than a
    ;; string pointer; a real DLL's export table can answer either form, so the
    ;; ordinal case is resolved here and only falls through to the "not loaded"
    ;; Win32-thunk path (which has no ordinals) when no DLL matches.
    (local.set $i (i32.const 0))
    (block $not_dll (loop $scan_dll
      (br_if $not_dll (i32.ge_u (local.get $i) (global.get $dll_count)))
      (local.set $dll_base (i32.load (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $i) (i32.const 32)))))
      (if (i32.eq (local.get $dll_base) (local.get $arg0))
        (then
          ;; Ordinal form: resolve straight from the export address table.
          (if (i32.lt_u (local.get $arg1) (i32.const 0x10000))
            (then
              (global.set $eax (call $resolve_ordinal (local.get $i) (local.get $arg1)))
              (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
              (return)))
          ;; Flat scrollbar APIs are optional. Let VCL/common-control callers
          ;; use their USER32 fallback wrappers instead of entering the loaded
          ;; comctl32 FlatSB code path, which depends on native subclass state.
          (if (call $guest_name_contains_flatsb (local.get $arg1))
            (then
              (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
              (return)))
          ;; Found matching DLL — resolve export by name
          (local.set $resolved (call $resolve_name_export (local.get $i) (call $g2w (local.get $arg1))))
          (if (local.get $resolved)
            (then
              (global.set $eax (local.get $resolved))
              (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
              (return)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan_dll)))
    ;; Not a loaded DLL — create thunk as before (Win32 API). Win32 stubs are
    ;; keyed by name only, so an ordinal here stays unresolved.
    (br_if $gpa (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
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

  ;; 5: GetLastError — return thread-global Win32 last-error value.
  (func $handle_GetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $last_error))
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
    (local $buf i32) (local $cch i32)
    (local.set $cch (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $buf (call $g2w (local.get $arg4)))
    (if (i32.and (i32.ne (local.get $arg4) (i32.const 0)) (i32.ge_u (local.get $cch) (i32.const 12)))
      (then
        ;; Write "12:00:00 AM\0".
        (i32.store (local.get $buf) (i32.const 0x303a3231))
        (i32.store (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x30303a30))
        (i32.store (i32.add (local.get $buf) (i32.const 8)) (i32.const 0x004d4120))
        (global.set $eax (i32.const 12))
      )
      (else
        (global.set $eax (i32.const 12))
      ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args + ret
  )

  ;; 8: GetDateFormatA(Locale, dwFlags, lpDate, lpFormat, lpDateStr, cchDateStr) — 6 args stdcall
  (func $handle_GetDateFormatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $cch i32) (local $long i32)
    ;; Read cchDateStr from stack (6th arg at esp+24)
    (local.set $cch (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $long (i32.and (local.get $arg1) (i32.const 2))) ;; DATE_LONGDATE
    ;; EnumDateFormats callers pass the format explicitly. The stable long
    ;; pattern starts with 'd'; the stable short pattern starts with 'M'.
    (if (local.get $arg3)
      (then
        (if (i32.eq (i32.load8_u (call $g2w (local.get $arg3))) (i32.const 0x64))
          (then (local.set $long (i32.const 1))))))
    (local.set $buf (call $g2w (local.get $arg4)))
    (if (i32.and (local.get $long)
          (i32.and (i32.ne (local.get $arg4) (i32.const 0)) (i32.ge_u (local.get $cch) (i32.const 24))))
      (then
        ;; "Monday, January 1, 2001\0"
        (i32.store (local.get $buf) (i32.const 0x646e6f4d))
        (i32.store (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x202c7961))
        (i32.store (i32.add (local.get $buf) (i32.const 8)) (i32.const 0x756e614a))
        (i32.store (i32.add (local.get $buf) (i32.const 12)) (i32.const 0x20797261))
        (i32.store (i32.add (local.get $buf) (i32.const 16)) (i32.const 0x32202c31))
        (i32.store (i32.add (local.get $buf) (i32.const 20)) (i32.const 0x00313030))
        (global.set $eax (i32.const 24))
      )
      (else
        (if (i32.and (i32.ne (local.get $arg4) (i32.const 0)) (i32.ge_u (local.get $cch) (i32.const 7)))
          (then
            ;; "1/1/01\0"
            (i32.store (local.get $buf) (i32.const 0x2f312f31))
            (i32.store16 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x3130))
            (i32.store8 (i32.add (local.get $buf) (i32.const 6)) (i32.const 0)))
          (else
            (global.set $eax (select (i32.const 24) (i32.const 7) (local.get $long)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
            (return)))
        (global.set $eax (i32.const 7))
      ))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args + ret
  )

  ;; EnumDateFormatsA / EnumTimeFormatsA invoke one stable US-English format
  ;; callback per call. Callers such as Win98 WordPad request short and long
  ;; date formats separately, so one representative for each flag is enough
  ;; to populate their Date and Time dialog without inventing locale state.
  (func $locale_format_enum_a (param $callback i32) (param $flags i32)
        (param $ret_addr i32) (param $is_time i32)
    (local $text i32) (local $wa i32)
    (if (i32.eqz (local.get $callback))
      (then
        (global.set $eax (i32.const 0))
        (global.set $eip (local.get $ret_addr))
        (return)))
    (local.set $text (call $heap_alloc (i32.const 32)))
    (local.set $wa (call $g2w (local.get $text)))
    (call $zero_memory (local.get $wa) (i32.const 32))
    (if (local.get $is_time)
      (then
        ;; "h:mm:ss tt"
        (i32.store (local.get $wa) (i32.const 0x3a6d3a68))
        (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x74207373))
        (i32.store16 (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x0074)))
      (else
        (if (i32.and (local.get $flags) (i32.const 2)) ;; DATE_LONGDATE
          (then
            ;; "dddd, MMMM d, yyyy"
            (i32.store (local.get $wa) (i32.const 0x64646464))
            (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x4d4d202c))
            (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x64204d4d))
            (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x7979202c))
            (i32.store16 (i32.add (local.get $wa) (i32.const 16)) (i32.const 0x7979)))
          (else
            ;; "M/d/yy"
            (i32.store (local.get $wa) (i32.const 0x2f642f4d))
            (i32.store16 (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x7979))))))
    ;; Preserve the API caller return address above the callback's stdcall
    ;; frame. CACA0011 is a generic one-callback continuation: it restores this
    ;; address after the callback has popped its LPSTR argument.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $text))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $font_enum_ret_thunk))
    (global.set $eip (local.get $callback))
    (global.set $steps (i32.const 0)))

  (func $handle_EnumDateFormatsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (call $locale_format_enum_a (local.get $arg0) (local.get $arg2) (local.get $ret) (i32.const 0)))

  (func $handle_EnumTimeFormatsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (call $locale_format_enum_a (local.get $arg0) (local.get $arg2) (local.get $ret) (i32.const 1)))

  ;; EnumResourceLanguagesW(hModule, type, name, callback, lParam). PE resource
  ;; lookup already falls back to the available language; enumerate the stable
  ;; US-English LANGID expected by Win98 common controls and MFC property sheets.
  (func $handle_EnumResourceLanguagesW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (if (i32.eqz (local.get $arg3))
      (then
        (global.set $eax (i32.const 0))
        (global.set $eip (local.get $ret))
        (return)))
    ;; Preserve API return and push ENUMRESLANGPROCW args right-to-left.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg4))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0x0409))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg2))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg1))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg0))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $font_enum_ret_thunk))
    (global.set $eip (local.get $arg3))
    (global.set $steps (i32.const 0)))

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

  ;; GetProfileSectionA(appName, retBuf, nSize) → chars copied
  ;;
  ;; RichEdit queries win.ini's "FontSubstitutes" section while processing
  ;; clipboard and formatting paths. Returning an empty double-NUL section is
  ;; valid for "section exists but has no entries" and is safer than crashing;
  ;; callers that need real profile persistence still use GetProfileStringA /
  ;; WriteProfileStringA.
  (func $handle_GetProfileSectionA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    (drop (local.get $arg0))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (if (i32.and
          (i32.ne (local.get $arg1) (i32.const 0))
          (i32.gt_u (local.get $arg2) (i32.const 0)))
      (then
        (local.set $buf (call $g2w (local.get $arg1)))
        (i32.store8 (local.get $buf) (i32.const 0))
        (if (i32.gt_u (local.get $arg2) (i32.const 1))
          (then (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 0))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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

  ;; The locale values we can answer are one character each, so the two
  ;; spellings differ only in how wide that character is written. Returns the
  ;; number of characters the value needs, counting the terminator, which is
  ;; also what a cchData==0 measuring call asks for.
  (func $locale_info (param $lctype i32) (param $out_g i32) (param $cch i32)
      (param $wide i32) (result i32)
    (local $ch i32)
    (local.set $ch (i32.const 0x30))                                   ;; "0"
    (if (i32.eq (local.get $lctype) (i32.const 0x0E))                  ;; LOCALE_SDECIMAL
      (then (local.set $ch (i32.const 0x2E))))                         ;; "."
    (if (i32.eq (local.get $lctype) (i32.const 0x0F))                  ;; LOCALE_STHOUSAND
      (then (local.set $ch (i32.const 0x2C))))                         ;; ","
    (if (i32.eqz (local.get $cch)) (then (return (i32.const 2))))
    (if (i32.or (i32.eqz (local.get $out_g)) (i32.lt_s (local.get $cch) (i32.const 2)))
      (then (return (i32.const 0))))
    (if (local.get $wide)
      (then
        (call $gs16 (local.get $out_g) (local.get $ch))
        (call $gs16 (i32.add (local.get $out_g) (i32.const 2)) (i32.const 0)))
      (else
        (call $gs8 (local.get $out_g) (local.get $ch))
        (call $gs8 (i32.add (local.get $out_g) (i32.const 1)) (i32.const 0))))
    (i32.const 2))

  ;; 11: GetLocaleInfoA(Locale, LCType, lpLCData, cchData). This returned 0 —
  ;; "no such locale value" — for every query while the W spelling answered, so
  ;; an ANSI app asking for the decimal separator formatted numbers with
  ;; whatever it fell back to.
  (func $handle_GetLocaleInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $locale_info
      (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 0)))
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
        (global.set $handler_set_eip (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (global.set $yield_reason (i32.const 5))
        (global.set $yield_flag (i32.const 1))
        (global.set $steps (i32.const 0))
        (return)))
    ;; uxtheme.dll is optional and absent on Win98. Returning a synthetic
    ;; handle makes VCL cache NULL theming procedure pointers, then call them.
    (if (call $dll_name_match (local.get $arg0) (i32.const 0x36D))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    ;; Not found — return EXE base (system DLL stub) so GetProcAddress can create thunks
    (global.set $eax (global.get $image_base))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; LoadLibraryExA(lpFileName, hFile, dwFlags). With dwFlags=0 this is
  ;; exactly LoadLibraryA; the Wise DX-Ball installer uses that documented
  ;; form to obtain KERNEL32 before probing an optional procedure.
  (func $handle_LoadLibraryExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_LoadLibraryA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
    ;; LoadLibraryA consumed its return address plus one argument. Consume the
    ;; two additional Ex arguments without changing its result/yield state.
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DdeInitializeA(pidInst, callback, afCmd, ulRes). Provide the process-local
  ;; DDE instance used by Wise to register its single-installer service.
  (func $handle_DdeInitializeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.ne (local.get $arg0) (i32.const 0))
      (then (call $gs32 (local.get $arg0) (i32.const 1))))
    (global.set $eax (i32.const 0)) ;; DMLERR_NO_ERROR
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; Process-local HSZ handles retain the guest string pointer. That is enough
  ;; for Wise's single-instance service registration and later free call.
  (func $handle_DdeCreateStringHandleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_DdeNameService (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  (func $handle_DdeFreeStringHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_DdeUninitialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DosDateTimeToFileTime(wFatDate, wFatTime, lpFileTime). Convert the FAT
  ;; local calendar fields to 100ns ticks since 1601-01-01. Timezone
  ;; conversion, when requested, is handled separately by
  ;; LocalFileTimeToFileTime.
  (func $handle_DosDateTimeToFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $year i32) (local $month i32) (local $day i32)
    (local $hour i32) (local $minute i32) (local $second i32)
    (local $leap i32) (local $max_day i32) (local $month_days i32)
    (local $year_minus_one i32) (local $days i32) (local $ticks i64)
    (local.set $year (i32.add (i32.const 1980)
      (i32.and (i32.shr_u (local.get $arg0) (i32.const 9)) (i32.const 0x7f))))
    (local.set $month (i32.and (i32.shr_u (local.get $arg0) (i32.const 5)) (i32.const 0x0f)))
    (local.set $day (i32.and (local.get $arg0) (i32.const 0x1f)))
    (local.set $hour (i32.and (i32.shr_u (local.get $arg1) (i32.const 11)) (i32.const 0x1f)))
    (local.set $minute (i32.and (i32.shr_u (local.get $arg1) (i32.const 5)) (i32.const 0x3f)))
    (local.set $second (i32.mul (i32.and (local.get $arg1) (i32.const 0x1f)) (i32.const 2)))

    (local.set $leap
      (i32.or
        (i32.eq (i32.rem_u (local.get $year) (i32.const 400)) (i32.const 0))
        (i32.and
          (i32.eq (i32.rem_u (local.get $year) (i32.const 4)) (i32.const 0))
          (i32.ne (i32.rem_u (local.get $year) (i32.const 100)) (i32.const 0)))))
    (local.set $max_day (i32.const 31))
    (if (i32.eq (local.get $month) (i32.const 2))
      (then (local.set $max_day (i32.add (i32.const 28) (local.get $leap))))
      (else
        (if (i32.or
              (i32.or (i32.eq (local.get $month) (i32.const 4)) (i32.eq (local.get $month) (i32.const 6)))
              (i32.or (i32.eq (local.get $month) (i32.const 9)) (i32.eq (local.get $month) (i32.const 11))))
          (then (local.set $max_day (i32.const 30))))))

    (if
      (i32.and
        (i32.and
          (i32.and (i32.ge_u (local.get $month) (i32.const 1)) (i32.le_u (local.get $month) (i32.const 12)))
          (i32.and (i32.ge_u (local.get $day) (i32.const 1)) (i32.le_u (local.get $day) (local.get $max_day))))
        (i32.and
          (i32.and (i32.le_u (local.get $hour) (i32.const 23)) (i32.le_u (local.get $minute) (i32.const 59)))
          (i32.ne (local.get $arg2) (i32.const 0))))
      (then
        ;; Cumulative days before the selected month in a non-leap year.
        (if (i32.eq (local.get $month) (i32.const 1)) (then (local.set $month_days (i32.const 0)))
          (else (if (i32.eq (local.get $month) (i32.const 2)) (then (local.set $month_days (i32.const 31)))
          (else (if (i32.eq (local.get $month) (i32.const 3)) (then (local.set $month_days (i32.const 59)))
          (else (if (i32.eq (local.get $month) (i32.const 4)) (then (local.set $month_days (i32.const 90)))
          (else (if (i32.eq (local.get $month) (i32.const 5)) (then (local.set $month_days (i32.const 120)))
          (else (if (i32.eq (local.get $month) (i32.const 6)) (then (local.set $month_days (i32.const 151)))
          (else (if (i32.eq (local.get $month) (i32.const 7)) (then (local.set $month_days (i32.const 181)))
          (else (if (i32.eq (local.get $month) (i32.const 8)) (then (local.set $month_days (i32.const 212)))
          (else (if (i32.eq (local.get $month) (i32.const 9)) (then (local.set $month_days (i32.const 243)))
          (else (if (i32.eq (local.get $month) (i32.const 10)) (then (local.set $month_days (i32.const 273)))
          (else (if (i32.eq (local.get $month) (i32.const 11)) (then (local.set $month_days (i32.const 304)))
          (else (local.set $month_days (i32.const 334))))))))))))))))))))))))
        (if (i32.and (i32.gt_u (local.get $month) (i32.const 2)) (local.get $leap))
          (then (local.set $month_days (i32.add (local.get $month_days) (i32.const 1)))))
        (local.set $year_minus_one (i32.sub (local.get $year) (i32.const 1)))
        (local.set $days
          (i32.add
            (i32.sub
              (i32.add
                (i32.add
                  (i32.mul (local.get $year_minus_one) (i32.const 365))
                  (i32.div_u (local.get $year_minus_one) (i32.const 4)))
                (i32.div_u (local.get $year_minus_one) (i32.const 400)))
              (i32.add (i32.div_u (local.get $year_minus_one) (i32.const 100)) (i32.const 584388)))
            (i32.add (local.get $month_days) (i32.sub (local.get $day) (i32.const 1)))))
        (local.set $ticks
          (i64.mul
            (i64.add
              (i64.mul (i64.extend_i32_u (local.get $days)) (i64.const 86400))
              (i64.extend_i32_u
                (i32.add
                  (i32.add (i32.mul (local.get $hour) (i32.const 3600)) (i32.mul (local.get $minute) (i32.const 60)))
                  (local.get $second))))
            (i64.const 10000000)))
        (i64.store (call $g2w (local.get $arg2)) (local.get $ticks))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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
    ;; RichEdit uses 32767 twips as an internal "effectively infinite" size
    ;; sentinel. Letting the generic pixel conversion through turns that into
    ;; a thousands-pixel document/font metric and WordPad scrolls typed text
    ;; offscreen. Clamp this exact screen-DPI twips conversion to a normal line
    ;; height.
    (if (i32.and
          (i32.and
            (i32.eq (local.get $arg0) (i32.const 32767))
            (i32.eq (local.get $arg1) (i32.const 96)))
          (i32.eq (local.get $arg2) (i32.const 1440)))
      (then
        (global.set $eax (i32.const 16))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
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

  ;; 19: _lcreat(lpPathName, iAttribute) — 2 args stdcall.
  ;; Equivalent to CreateFile(path, GENERIC_READ|GENERIC_WRITE, 0, NULL,
  ;; CREATE_ALWAYS, iAttribute, NULL). Returns HFILE or HFILE_ERROR(-1).
  (func $handle__lcreat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $attr i32)
    ;; iAttribute: 0=normal, 1=readonly, 2=hidden, 3=system. Map low bits to
    ;; FILE_ATTRIBUTE_*; default to NORMAL when iAttribute=0.
    (local.set $attr (i32.or (local.get $arg1) (i32.const 0x80)))
    (global.set $eax (call $host_fs_create_legacy_file
      (call $g2w (local.get $arg0))
      (i32.const 0xC0000000)  ;; GENERIC_READ | GENERIC_WRITE
      (i32.const 2)           ;; CREATE_ALWAYS
      (local.get $attr)
      (i32.const 0)))         ;; isWide=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args + ret
  )

  ;; 20: _lopen — STUB: unimplemented
  (func $handle__lopen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; _lopen(lpPathName, iReadWrite) — 2 args stdcall
    (global.set $eax (call $host_fs_create_legacy_file
      (call $g2w (local.get $arg0))
      (i32.const 0x80000000)  ;; GENERIC_READ
      (i32.const 3)           ;; OPEN_EXISTING
      (i32.const 0x80)        ;; FILE_ATTRIBUTE_NORMAL
      (i32.const 0)))         ;; isWide=0
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args + ret
  )

  ;; 21: _lwrite(hFile, lpBuffer, uBytes) — 3 args stdcall.
  ;; Returns bytes written, or HFILE_ERROR(-1) on failure.
  (func $handle__lwrite (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $bytes_written_ga i32) (local $bytes_written_wa i32)
    (local.set $bytes_written_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_written_wa (call $g2w (local.get $bytes_written_ga)))
    (i32.store (local.get $bytes_written_wa) (i32.const 0))
    (if (call $host_fs_write_file
          (local.get $arg0) (local.get $arg1)
          (local.get $arg2) (local.get $bytes_written_ga))
      (then (global.set $eax (i32.load (local.get $bytes_written_wa))))
      (else (global.set $eax (i32.const 0xFFFFFFFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args + ret
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

  ;; VkKeyScanA(CHAR ch) → SHORT. The low byte is the virtual-key code and
  ;; the high byte contains modifier state (bit 0 = SHIFT).
  ;; Character → (shift state << 8) | virtual key, or 0xFFFF for a character
  ;; this keyboard cannot produce. Both spellings translate the same character
  ;; set, so they translate it in the same place.
  (func $vk_key_scan (param $ch i32) (result i32)
    ;; 'a'-'z' → vkey = uppercase, shift=0
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61)) (i32.le_u (local.get $ch) (i32.const 0x7A)))
      (then (return (i32.sub (local.get $ch) (i32.const 0x20)))))
    ;; 'A'-'Z' → vkey = char, shift=1 (high byte = 0x01)
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x41)) (i32.le_u (local.get $ch) (i32.const 0x5A)))
      (then (return (i32.or (local.get $ch) (i32.const 0x0100)))))
    ;; '0'-'9' → vkey = char, shift=0
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x30)) (i32.le_u (local.get $ch) (i32.const 0x39)))
      (then (return (local.get $ch))))
    ;; Space, Tab, Enter, Escape, Backspace
    (if (i32.eq (local.get $ch) (i32.const 0x20)) (then (return (i32.const 0x20))))
    (if (i32.eq (local.get $ch) (i32.const 0x09)) (then (return (i32.const 0x09))))
    (if (i32.eq (local.get $ch) (i32.const 0x0D)) (then (return (i32.const 0x0D))))
    (if (i32.eq (local.get $ch) (i32.const 0x1B)) (then (return (i32.const 0x1B))))
    (if (i32.eq (local.get $ch) (i32.const 0x08)) (then (return (i32.const 0x08))))
    (i32.const 0xFFFF))

  (func $handle_VkKeyScanA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $vk_key_scan (i32.and (local.get $arg0) (i32.const 0xFF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; LZ32's file APIs also accept ordinary, uncompressed files. Font Viewer
  ;; uses that path for font-resource files, so map the handle operations onto
  ;; the VFS. SZDD decompression can be added separately if a caller needs it.
  (func $handle_LZOpenFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $handle i32) (local $of_wa i32)
    (local.set $handle (call $host_fs_create_file
      (call $g2w (local.get $arg0))
      (i32.const 0x80000000)  ;; GENERIC_READ
      (i32.const 3)           ;; OPEN_EXISTING
      (i32.const 0x80)        ;; FILE_ATTRIBUTE_NORMAL
      (i32.const 0)))         ;; ANSI path
    (if (local.get $arg1)
      (then
        (local.set $of_wa (call $g2w (local.get $arg1)))
        (i32.store8 (local.get $of_wa) (i32.const 136))
        (i32.store16 offset=2 (local.get $of_wa)
          (select (i32.const 2) (i32.const 0)
            (i32.eq (local.get $handle) (i32.const -1))))))
    (global.set $eax (local.get $handle))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_LZRead (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $bytes_ga i32) (local $bytes_wa i32)
    (local.set $bytes_ga (i32.sub (global.get $esp) (i32.const 4)))
    (local.set $bytes_wa (call $g2w (local.get $bytes_ga)))
    (i32.store (local.get $bytes_wa) (i32.const 0))
    (if (call $host_fs_read_file
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $bytes_ga))
      (then (global.set $eax (i32.load (local.get $bytes_wa))))
      (else (global.set $eax (i32.const -1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_LZSeek (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_set_file_pointer
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  (func $handle_LZClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_fs_close_handle (local.get $arg0)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
      (then
        (global.set $sleep_yielded (i32.const 1))
        (global.set $sleep_timeout (local.get $arg0))))
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
    ;; Pass dwCreationFlags into the host so CREATE_SUSPENDED is part of the
    ;; atomic creation event instead of a briefly-runnable create followed by
    ;; a separate SuspendThread call.
    (global.set $eax (call $host_create_thread
      (local.get $arg2) (local.get $arg3) (local.get $arg1) (local.get $arg4)))
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
        (global.set $wait_timeout (local.get $arg1))
        (global.set $wait_stack_bytes (i32.const 12))
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

  ;; 37: HeapReAlloc(hHeap, dwFlags, lpMem, dwBytes)
  ;;
  ;; A growing block must carry over only what the OLD block actually held.
  ;; This used to copy dwBytes — the NEW size — out of the old allocation,
  ;; so every grow read past the end of the source and pulled whatever
  ;; happened to sit behind it into the fresh block. HEAP_ZERO_MEMORY was
  ;; ignored on top of that, so the caller asked for zeros and got that
  ;; trailing garbage instead. Real d3drm's .x parser grows its arrays this
  ;; way (4 bytes to 8, HEAP_ZERO_MEMORY) while parsing a ProgressiveMesh.
  ;;
  ;; $heap_alloc puts the block size at ptr-4 and it covers the header plus
  ;; padding, so the usable old payload is that size minus the header. A
  ;; pointer below $heap_base is not ours (msvcrt's own sub-allocator hands
  ;; those out) and has no header to read, so it keeps the old best-effort
  ;; copy — there is nothing better to be had without knowing its size.
  (func $handle_HeapReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $old_usable i32) (local $copy i32)
    (block $done
      (if (i32.eqz (local.get $arg2))
        (then
          ;; No old block: this is a plain allocation.
          (local.set $tmp (call $heap_alloc (local.get $arg3)))
          (if (i32.and (i32.ne (local.get $tmp) (i32.const 0))
                       (i32.ne (i32.and (local.get $arg1) (i32.const 0x08)) (i32.const 0)))
            (then (call $zero_memory (call $g2w (local.get $tmp)) (local.get $arg3))))
          (br $done)))
      (if (i32.lt_u (local.get $arg2) (global.get $heap_base))
        (then (local.set $old_usable (i32.const -1)))   ;; foreign: size unknown
        (else
          (local.set $old_usable
            (i32.sub (i32.load (call $g2w (i32.sub (local.get $arg2) (i32.const 4))))
                     (i32.const 4)))))
      ;; HEAP_REALLOC_IN_PLACE_ONLY (0x10): the caller is telling us other
      ;; pointers into this block are still live, so moving it would corrupt
      ;; them. Satisfy it only when the block already has the room; Windows
      ;; returns NULL rather than relocating, and so do we.
      (if (i32.ne (i32.and (local.get $arg1) (i32.const 0x10)) (i32.const 0))
        (then
          (if (i32.or (i32.eq (local.get $old_usable) (i32.const -1))
                      (i32.gt_u (local.get $arg3) (local.get $old_usable)))
            (then (local.set $tmp (i32.const 0)) (br $done)))
          (if (i32.and (i32.ne (i32.and (local.get $arg1) (i32.const 0x08)) (i32.const 0))
                       (i32.gt_u (local.get $arg3) (local.get $old_usable)))
            (then (call $zero_memory
                    (call $g2w (i32.add (local.get $arg2) (local.get $old_usable)))
                    (i32.sub (local.get $arg3) (local.get $old_usable)))))
          (local.set $tmp (local.get $arg2))
          (br $done)))
      (local.set $tmp (call $heap_alloc (local.get $arg3)))
      (if (i32.eqz (local.get $tmp)) (then (br $done)))
      ;; Carry over min(old payload, new size); a shrink copies only what fits.
      (local.set $copy (local.get $arg3))
      (if (i32.and (i32.ne (local.get $old_usable) (i32.const -1))
                   (i32.lt_u (local.get $old_usable) (local.get $copy)))
        (then (local.set $copy (local.get $old_usable))))
      (call $memcpy (call $g2w (local.get $tmp)) (call $g2w (local.get $arg2)) (local.get $copy))
      ;; The grown tail is the caller's to define; zero it when asked.
      (if (i32.and (i32.ne (i32.and (local.get $arg1) (i32.const 0x08)) (i32.const 0))
                   (i32.gt_u (local.get $arg3) (local.get $copy)))
        (then (call $zero_memory
                (call $g2w (i32.add (local.get $tmp) (local.get $copy)))
                (i32.sub (local.get $arg3) (local.get $copy)))))
      (call $heap_free (local.get $arg2)))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 38: VirtualAlloc(lpAddr, dwSize, flAllocType, flProtect)
  ;; NULL reserves return 64KB-granularity bases; commits are page-aligned.
  (func $handle_VirtualAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $size i32) (local $new_top i32)
    ;; Round size up to page boundary
    (local.set $size (i32.and (i32.add (local.get $arg1) (i32.const 0xFFF)) (i32.const 0xFFFFF000)))
    (if (i32.eqz (local.get $size))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (if (local.get $arg0)
      (then
        (if (i32.ge_u (local.get $arg0) (global.get $VIRTUAL_ALLOC_MIN))
          (then
            ;; Commit into a sparse high guest reserve.
            (global.set $eax (call $virtual_map_commit (local.get $arg0) (local.get $size))))
          (else
            ;; MEM_COMMIT at an existing low address. Refuse commits that would
            ;; map into emulator-private decoded-code/cache memory.
            (if (i32.gt_u
                  (call $g2w (i32.add (local.get $arg0) (local.get $size)))
                  (global.get $THREAD_CACHE_BASE))
              (then (global.set $eax (i32.const 0)))
              (else (global.set $eax (local.get $arg0)))))))
      (else
        ;; Reserve from a sparse high guest-address arena, separate from
        ;; HeapAlloc's upward-growing low heap. MEM_RESERVE is address-space
        ;; bookkeeping; real backing is added only by MEM_COMMIT.
        (local.set $new_top (call $virtual_reserve_down (local.get $size)))
        (if (i32.eqz (local.get $new_top))
          (then (global.set $eax (i32.const 0)))
          (else
            (if (i32.and (local.get $arg2) (i32.const 0x1000))
              (then (global.set $eax (call $virtual_map_commit (local.get $new_top) (local.get $size))))
              (else (global.set $eax (local.get $new_top))))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 39: VirtualFree — return TRUE (no real decommit needed)
  (func $handle_VirtualFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 40: GetACP — process ANSI code page
  (func $handle_GetACP (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $ansi_code_page))
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
    (local $cp i32) (local $info i32)
    ;; CPINFO struct: MaxCharSize(4), DefaultChar[2](2), LeadByte[12](12)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $cp (call $resolve_code_page (local.get $arg0)))
    (local.set $info (call $g2w (local.get $arg1)))
    (call $zero_memory (local.get $info) (i32.const 18))
    (i32.store8 offset=4 (local.get $info) (i32.const 0x3F)) ;; DefaultChar = "?"
    (if (call $is_dbcs_code_page (local.get $cp))
      (then
        (call $gs32 (local.get $arg1) (i32.const 2)) ;; MaxCharSize = 2
        (if (i32.eq (local.get $cp) (i32.const 932))
          (then
            (i32.store8 offset=6 (local.get $info) (i32.const 0x81))
            (i32.store8 offset=7 (local.get $info) (i32.const 0x9F))
            (i32.store8 offset=8 (local.get $info) (i32.const 0xE0))
            (i32.store8 offset=9 (local.get $info) (i32.const 0xFC)))
          (else
            (if (i32.eq (local.get $cp) (i32.const 1361))
              (then
                (i32.store8 offset=6 (local.get $info) (i32.const 0x84))
                (i32.store8 offset=7 (local.get $info) (i32.const 0xD3))
                (i32.store8 offset=8 (local.get $info) (i32.const 0xD8))
                (i32.store8 offset=9 (local.get $info) (i32.const 0xDE))
                (i32.store8 offset=10 (local.get $info) (i32.const 0xE0))
                (i32.store8 offset=11 (local.get $info) (i32.const 0xF9)))
              (else
                (i32.store8 offset=6 (local.get $info) (i32.const 0x81))
                (i32.store8 offset=7 (local.get $info) (i32.const 0xFE)))))))
      (else
        (call $gs32 (local.get $arg1) (i32.const 1)))) ;; MaxCharSize = 1
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

  ;; ASCII CT_CTYPE1 classification used by GetStringTypeA/W and the Ex
  ;; variants. CT_CTYPE1 bits: C1_UPPER=1 C1_LOWER=2 C1_DIGIT=4
  ;; C1_SPACE=8 C1_PUNCT=16 C1_CNTRL=32 C1_ALPHA=256.
  (func $ctype1_ascii_flags (param $ch i32) (result i32)
    (local $ct i32)
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
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 91)) (i32.le_u (local.get $ch) (i32.const 96)))
      (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x10)))))
    (if (i32.and (i32.ge_u (local.get $ch) (i32.const 123)) (i32.le_u (local.get $ch) (i32.const 126)))
      (then (local.set $ct (i32.or (local.get $ct) (i32.const 0x10)))))
    (local.get $ct)
  )

  (func $get_string_type_a_core (param $src_guest i32) (param $count_in i32) (param $out_guest i32) (result i32)
    (local $i i32) (local $ch i32) (local $out i32) (local $src i32) (local $count i32)
    (if (i32.eqz (local.get $src_guest)) (then (return (i32.const 0))))
    (if (i32.eqz (local.get $out_guest)) (then (return (i32.const 0))))
    (local.set $src (call $g2w (local.get $src_guest)))
    (local.set $out (call $g2w (local.get $out_guest)))
    (local.set $count (local.get $count_in))
    (if (i32.eq (local.get $count) (i32.const -1))
      (then (local.set $count (i32.add (call $strlen_a (local.get $src)) (i32.const 1)))))
    (local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (i32.store16
        (i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 2)))
        (call $ctype1_ascii_flags (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (i32.const 1)
  )

  (func $get_string_type_w_core (param $src_guest i32) (param $count_in i32) (param $out_guest i32) (result i32)
    (local $i i32) (local $ch i32) (local $out i32) (local $src i32) (local $count i32)
    (if (i32.eqz (local.get $src_guest)) (then (return (i32.const 0))))
    (if (i32.eqz (local.get $out_guest)) (then (return (i32.const 0))))
    (local.set $src (call $g2w (local.get $src_guest)))
    (local.set $out (call $g2w (local.get $out_guest)))
    (local.set $count (local.get $count_in))
    (if (i32.eq (local.get $count) (i32.const -1))
      (then (local.set $count (i32.add (call $strlen_w (local.get $src)) (i32.const 1)))))
    (local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $ch (i32.load16_u (i32.add (local.get $src) (i32.mul (local.get $i) (i32.const 2)))))
      (i32.store16
        (i32.add (local.get $out) (i32.mul (local.get $i) (i32.const 2)))
        (call $ctype1_ascii_flags (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (i32.const 1)
  )

  ;; 45: GetStringTypeA(Locale, dwInfoType, lpSrcStr, cchSrc, lpCharType) — single-byte CT_CTYPE1 classification.
  (func $handle_GetStringTypeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $get_string_type_a_core (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; 46: GetStringTypeW(dwInfoType, lpSrcStr, cchSrc, lpCharType) — classify chars.
  (func $handle_GetStringTypeW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $get_string_type_w_core (local.get $arg1) (local.get $arg2) (local.get $arg3)))
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

  ;; 53: GetEnvironmentStrings — the undecorated name is the ANSI one.
  (func $handle_GetEnvironmentStrings (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $env_strings (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 54: GetModuleFileNameA
  ;; "C:\<exe_name>" into the caller's buffer, ANSI or wide, truncated to
  ;; nSize characters as Win32 does. Returns the characters written, not
  ;; counting the terminator. One writer for both spellings.
  (func $module_file_name (param $buf_g i32) (param $size i32) (param $wide i32) (result i32)
    (local $i i32) (local $n i32) (local $ch i32) (local $step i32)
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (if (i32.eqz (local.get $buf_g)) (then (return (i32.const 0))))
    (local.set $n (i32.add (global.get $exe_name_len) (i32.const 3)))
    ;; Leave room for the terminator.
    (if (i32.and (i32.gt_u (local.get $size) (i32.const 0))
                 (i32.ge_u (local.get $n) (local.get $size)))
      (then (local.set $n (i32.sub (local.get $size) (i32.const 1)))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $ch (block $c (result i32)
        (if (i32.eq (local.get $i) (i32.const 0)) (then (br $c (i32.const 0x43))))  ;; 'C'
        (if (i32.eq (local.get $i) (i32.const 1)) (then (br $c (i32.const 0x3A))))  ;; ':'
        (if (i32.eq (local.get $i) (i32.const 2)) (then (br $c (i32.const 0x5C))))  ;; '\'
        (i32.load8_u (i32.add (global.get $exe_name_wa)
          (i32.sub (local.get $i) (i32.const 3))))))
      (call $store_char
        (i32.add (local.get $buf_g) (i32.mul (local.get $i) (local.get $step)))
        (local.get $ch) (local.get $wide))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (call $store_char
      (i32.add (local.get $buf_g) (i32.mul (local.get $n) (local.get $step)))
      (i32.const 0) (local.get $wide))
    (local.get $n))

  ;; One character to a guest address, ANSI or wide.
  (func $store_char (param $p_g i32) (param $ch i32) (param $wide i32)
    (if (local.get $wide)
      (then (call $gs16 (local.get $p_g) (local.get $ch)))
      (else (call $gs8 (local.get $p_g) (local.get $ch)))))

  (func $handle_GetModuleFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $module_file_name (local.get $arg1) (local.get $arg2) (i32.const 0)))
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

  ;; GetDoubleClickTime() → UINT. Win32 default is 500 ms unless customized.
  (func $handle_GetDoubleClickTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 500))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; 60: LoadResource(hModule, hResInfo) → HGLOBAL/resource-data pointer.
  ;; Keep the module context: HRSRC is an offset relative to the module whose
  ;; resource tree FindResource searched. Returning the raw offset loses that
  ;; context and makes native comctl32 parse the main EXE at a DLL-resource
  ;; offset when it builds property-sheet dialog templates.
  (func $handle_LoadResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rva i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (call $push_rsrc_ctx (local.get $arg0))
    (local.set $rva
      (call $gl32 (i32.add (call $r_base) (local.get $arg1))))
    (global.set $eax (i32.add (call $r_base) (local.get $rva)))
    (call $pop_rsrc_ctx)
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 61: LockResource
  (func $handle_LockResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LoadResource already resolves HRSRC through the owning module and
    ;; returns the stable resource-data pointer. LockResource exposes it.
    (global.set $eax (local.get $arg0))
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

  ;; 65: sndPlaySoundA(pszSound, fuSound) — legacy 2-arg sound API.
  ;; Handles resource and memory WAVs; file/alias names are accepted as no-op.
  (func $handle_sndPlaySoundA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $flags i32) (local $name_id i32) (local $hrsrc i32)
    (local $data_entry_wa i32) (local $data_rva i32) (local $data_size i32) (local $data_wa i32)
    (local.set $flags (local.get $arg1))
    (local.set $name_id (local.get $arg0))
    ;; NULL or SND_PURGE: stop current sound. We don't track active one-shots,
    ;; but Win9x callers treat TRUE as successful purge.
    (if (i32.or (i32.eqz (local.get $name_id))
                (i32.and (local.get $flags) (i32.const 0x40)))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; SND_MEMORY (0x4): pszSound points at a complete WAV image in memory.
    ;; Use the RIFF size at +4 plus the 8-byte RIFF header when it looks sane.
    (if (i32.and (local.get $flags) (i32.const 0x4))
      (then
        (local.set $data_wa (call $g2w (local.get $name_id)))
        (local.set $data_size (i32.add (i32.load (i32.add (local.get $data_wa) (i32.const 4))) (i32.const 8)))
        (if (i32.and
              (i32.eq (i32.load (local.get $data_wa)) (i32.const 0x46464952)) ;; "RIFF"
              (i32.gt_u (local.get $data_size) (i32.const 12)))
          (then (call $host_play_sound (local.get $data_wa) (local.get $data_size))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; SND_RESOURCE (0x40004): pszSound is MAKEINTRESOURCE(id).
    (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x40000)))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eqz (global.get $rsrc_rva))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (local.set $hrsrc (call $find_resource_named_type (local.get $name_id)))
    (if (i32.eqz (local.get $hrsrc))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (local.set $data_entry_wa (call $g2w (i32.add (global.get $image_base) (local.get $hrsrc))))
    (local.set $data_rva (i32.load (local.get $data_entry_wa)))
    (local.set $data_size (i32.load (i32.add (local.get $data_entry_wa) (i32.const 4))))
    (if (i32.eqz (local.get $data_size))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (local.set $data_wa (call $g2w (i32.add (global.get $image_base) (local.get $data_rva))))
    (call $host_play_sound (local.get $data_wa) (local.get $data_size))
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

  ;; RegisterWindowMessage is an *interning* call: registering the same name
  ;; twice must give the same number back, which is how two components (or two
  ;; spellings of one API) agree on what "commdlg_FindReplace" means. On
  ;; Windows the number comes from the global atom table, shared with
  ;; RegisterClipboardFormat, so intern through the same table $clipfmt_intern
  ;; owns. Both spellings land here; the W one only narrows on the way in.
  (func $register_window_message (param $name_g i32) (result i32)
    (local $id i32)
    (local.set $id (call $clipfmt_intern (local.get $name_g)))
    ;; FNV-1a("commdlg_FindReplace") = 0x1A9C8FD4. Common-dialog clients
    ;; register FINDMSGSTRING and later compare a delivered message against the
    ;; value they got, so the find/replace dialog has to send that same one.
    (if (i32.and
          (i32.ne (local.get $id) (i32.const 0))
          (i32.eq (call $hash_api_name (call $g2w (local.get $name_g)))
                  (i32.const 0x1A9C8FD4)))
      (then (global.set $findreplace_message (local.get $id))))
    (local.get $id))

  ;; 66: RegisterWindowMessageA(lpString) — return unique msg ID from 0xC000+ range
  (func $handle_RegisterWindowMessageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $register_window_message (local.get $arg0)))
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
    ;; top-level window — NOT a child of the destroyed window.  A hidden first
    ;; window may only be a startup/helper HWND: Pinball destroys its invisible
    ;; splash before creating the visible table window.  Do not leave a stale
    ;; WM_QUIT behind in that case; a later GetMessage path (Options > Music)
    ;; would consume it and terminate an otherwise healthy app.
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
    (then
      (if (i32.and
            (i32.ne (call $wnd_table_get (i32.add (global.get $main_hwnd) (i32.const 1))) (i32.const 0))
            (i32.ne (call $wnd_get_parent (i32.add (global.get $main_hwnd) (i32.const 1)))
                    (global.get $main_hwnd)))
        (then (global.set $main_hwnd (i32.add (global.get $main_hwnd) (i32.const 1))))
        (else
          (if (call $wnd_is_effectively_visible (local.get $arg0))
            (then (global.set $quit_flag (i32.const 1))))))))
    ;; Recursively destroy window and all its children (frees table slots)
    (call $wnd_destroy_recursive (local.get $arg0))
    ;; Transfer focus to main_hwnd: deliver WM_SETFOCUS synchronously via EIP redirect.
    ;; On real Windows, destroying the focused window gives focus to the next foreground window.
    ;; Only if main_hwnd is valid and different from the destroyed window (may have been promoted).
    (if (i32.and (i32.ne (local.get $focus_lost) (i32.const 0))
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

(func $compat_is_pinball_exe (result i32)
    (if (i32.ne (global.get $exe_name_len) (i32.const 11))
      (then (return (i32.const 0))))
    (if (i32.ne (i32.load (global.get $exe_name_wa)) (i32.const 0x626E6970))
      (then (return (i32.const 0)))) ;; pinb
    (if (i32.ne (i32.load offset=4 (global.get $exe_name_wa)) (i32.const 0x2E6C6C61))
      (then (return (i32.const 0)))) ;; all.
    (if (i32.ne (i32.load offset=8 (global.get $exe_name_wa)) (i32.const 0x00657865))
      (then (return (i32.const 0)))) ;; exe\0
    (i32.const 1))

  ;; 85: GetDC — Phase B: alloc DcRecord via host_alloc_window_dc
  ;; (whole=0). GetDC(NULL) and GetDC(GetDesktopWindow()) → screen DC.
  (func $handle_GetDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hdc i32) (local $target_hwnd i32)
    ;; Pinball uses its desktop handle as a window-clipped primary surface.
    ;; Giving it the canonical desktop bitmap draws the table behind
    ;; an opaque gray main window. Keep native desktop-DC behavior for other
    ;; apps (notably MFC WinHelp), but bind this request to Pinball's actual
    ;; compositor window.
    (if (i32.and
          (i32.eq (local.get $arg0) (i32.const 0x10000))
          (i32.and
            (call $compat_is_pinball_exe)
            (i32.ne (global.get $main_hwnd) (i32.const 0))))
      (then (local.set $target_hwnd (global.get $main_hwnd)))
      (else
        (if (i32.ne (local.get $arg0) (i32.const 0x10000))
          (then (local.set $target_hwnd (local.get $arg0))))))
    (if (local.get $target_hwnd)
      (then
        (local.set $hdc (call $host_alloc_window_dc (local.get $target_hwnd) (i32.const 0)))
        (call $dc_apply_client_clip (local.get $hdc) (local.get $target_hwnd)))
      (else
        (local.set $hdc (call $host_alloc_screen_dc))))
    (global.set $eax (local.get $hdc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; The SM_* table, with no calling convention attached. GetSystemMetrics is
  ;; the same question in Win32 and in Win16 — USER.179 takes the same indices
  ;; and means the same things — so the answers live here and both dispatchers
  ;; call in. An index with no entry is 0, which is what Windows returns for a
  ;; metric it does not define.
  (func $system_metric (param $index i32) (result i32)
    (if (i32.eq (local.get $index) (i32.const 0))  ;; SM_CXSCREEN
      (then (return (i32.and (call $host_get_screen_size) (i32.const 0xFFFF)))))
    (if (i32.eq (local.get $index) (i32.const 1))  ;; SM_CYSCREEN
      (then (return (i32.shr_u (call $host_get_screen_size) (i32.const 16)))))
    (if (i32.eq (local.get $index) (i32.const 4))  ;; SM_CYCAPTION
      (then (return (i32.const 19))))
    (if (i32.eq (local.get $index) (i32.const 5))  ;; SM_CXBORDER
      (then (return (i32.const 1))))
    (if (i32.eq (local.get $index) (i32.const 6))  ;; SM_CYBORDER
      (then (return (i32.const 1))))
    (if (i32.eq (local.get $index) (i32.const 7))  ;; SM_CXFIXEDFRAME
      (then (return (i32.const 3))))
    (if (i32.eq (local.get $index) (i32.const 8))  ;; SM_CYFIXEDFRAME
      (then (return (i32.const 3))))
    (if (i32.eq (local.get $index) (i32.const 11)) ;; SM_CXICON
      (then (return (i32.const 32))))
    (if (i32.eq (local.get $index) (i32.const 12)) ;; SM_CYICON
      (then (return (i32.const 32))))
    (if (i32.eq (local.get $index) (i32.const 15)) ;; SM_CYMENU
      (then (return (i32.const 19))))
    (if (i32.eq (local.get $index) (i32.const 16)) ;; SM_CXFULLSCREEN
      (then (return (i32.and (call $host_get_screen_size) (i32.const 0xFFFF)))))
    (if (i32.eq (local.get $index) (i32.const 17)) ;; SM_CYFULLSCREEN
      (then (return (i32.sub (i32.shr_u (call $host_get_screen_size) (i32.const 16))
                             (i32.const 46)))))
    (if (i32.eq (local.get $index) (i32.const 32)) ;; SM_CXFRAME
      (then (return (i32.const 4))))
    (if (i32.eq (local.get $index) (i32.const 33)) ;; SM_CYFRAME
      (then (return (i32.const 4))))
    ;; Native Win98 COMCTL32 uses the small-icon metrics to size image lists.
    ;; Returning zero makes ImageList_Create fail before controls can populate.
    (if (i32.eq (local.get $index) (i32.const 49)) ;; SM_CXSMICON
      (then (return (i32.const 16))))
    (if (i32.eq (local.get $index) (i32.const 50)) ;; SM_CYSMICON
      (then (return (i32.const 16))))
    (if (i32.eq (local.get $index) (i32.const 0x3D)) ;; SM_CXMAXIMIZED
      (then (return (i32.add (i32.and (call $host_get_screen_size) (i32.const 0xFFFF))
                             (i32.const 8)))))
    (if (i32.eq (local.get $index) (i32.const 0x3E)) ;; SM_CYMAXIMIZED
      (then (return (i32.add (i32.shr_u (call $host_get_screen_size) (i32.const 16))
                             (i32.const 8)))))
    (i32.const 0))

  ;; 90: GetSystemMetrics (actual slot used by imports)
  (func $handle_GetSystemMetrics (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $system_metric (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 1099: EnumDisplayMonitors(hdc, lprcClip, lpfnEnum, dwData) — 4 args stdcall
  ;; Calls lpfnEnum(hMonitor, hdcMonitor, lprcMonitor, dwData) once for primary monitor
  (func $handle_EnumDisplayMonitors (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32) (local $callback i32) (local $data i32) (local $rect_guest i32) (local $screen i32)
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
    ;; Allocate RECT {0, 0, screenW, screenH} on stack (16 bytes)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 16)))
    (local.set $rect_guest (i32.add (i32.sub (global.get $esp) (i32.const 0x12000)) (global.get $image_base)))
    (local.set $screen (call $host_get_screen_size))
    (call $gs32 (global.get $esp) (i32.const 0))         ;; left
    (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (i32.const 0))   ;; top
    (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.and (local.get $screen) (i32.const 0xFFFF))) ;; right
    (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (i32.shr_u (local.get $screen) (i32.const 16))) ;; bottom
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
    (local $cs i32) (local $style i32) (local $cw i32) (local $ch i32)
    ;; Controls live entirely in WAT (CONTROL_GEOM) — asking the host for
    ;; their client size falls back to the 640×480 desktop default because
    ;; child hwnds aren't in renderer.windows[], which then corrupts any
    ;; size calc the guest does from it (calc's dialog resize is one such
    ;; path). For controls, read the size directly from CONTROL_GEOM.
    ;; Generic child HWNDs (RichEdit, MFC views, etc.) also need WAT-owned
    ;; geometry. Their JS window objects are parent-relative surfaces, while
    ;; host_get_window_client_size returns top-level/client fallback sizes.
    (if (call $ctrl_table_get_class (local.get $arg0))
      (then (local.set $cs (call $ctrl_get_wh_packed (local.get $arg0))))
      (else
        (local.set $style (call $wnd_get_style (local.get $arg0)))
        (if (i32.and
              (i32.ne (call $wnd_get_parent (local.get $arg0)) (i32.const 0))
              (i32.ne (i32.and (local.get $style) (i32.const 0x40000000)) (i32.const 0)))
          (then
            (call $defwndproc_do_nccalcsize (local.get $arg0))
            (local.set $cw
              (i32.sub
                (call $client_rect_get_r (local.get $arg0))
                (call $client_rect_get_l (local.get $arg0))))
            (local.set $ch
              (i32.sub
                (call $client_rect_get_b (local.get $arg0))
                (call $client_rect_get_t (local.get $arg0))))
            (if (i32.or
                  (i32.le_s (local.get $cw) (i32.const 0))
                  (i32.le_s (local.get $ch) (i32.const 0)))
              (then (local.set $cs (call $ctrl_get_wh_packed (local.get $arg0))))
              (else
                (local.set $cs
                  (i32.or
                    (i32.and (local.get $cw) (i32.const 0xFFFF))
                    (i32.shl (local.get $ch) (i32.const 16)))))))
          (else
            (local.set $cs (call $host_get_window_client_size (local.get $arg0)))))))
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
  ;; A window's title as ANSI, into the guest buffer $buf ($max bytes), with
  ;; the character count as the result. There are three places a title can
  ;; live and both spellings of GetWindowText have to look in all of them, so
  ;; the search lives here and GetWindowTextW widens what it finds.
  (func $window_text_ansi (param $hwnd i32) (param $buf i32) (param $max i32) (result i32)
    (local $src i32) (local $len i32) (local $copy_len i32)
    ;; Child controls own their text in their WAT-side wndproc state. Route
    ;; the read through WM_GETTEXT so edit/button/static text stays consistent
    ;; with GetDlgItemTextA and SetWindowTextA.
    (if (call $ctrl_table_get_class (local.get $hwnd))
      (then
        (return (call $control_wndproc_dispatch
          (local.get $hwnd) (i32.const 0x000D)
          (local.get $max) (local.get $buf)))))
    ;; Registered custom controls created from dialog resources live in the
    ;; WAT window table but may have no renderer-side child mirror. Their
    ;; wndprocs still expect USER's normal window-text storage to work.
    (local.set $src (call $title_table_get_ptr (local.get $hwnd)))
    (if (local.get $src)
      (then
        (if (i32.le_s (local.get $max) (i32.const 0))
          (then (return (i32.const 0))))
        (local.set $len (call $title_table_get_len (local.get $hwnd)))
        (local.set $copy_len (local.get $len))
        (if (i32.ge_u (local.get $copy_len) (local.get $max))
          (then (local.set $copy_len (i32.sub (local.get $max) (i32.const 1)))))
        (call $memcpy (call $g2w (local.get $buf)) (local.get $src) (local.get $copy_len))
        (i32.store8 (i32.add (call $g2w (local.get $buf)) (local.get $copy_len)) (i32.const 0))
        (return (local.get $copy_len))))
    (call $host_get_window_text
      (local.get $hwnd) (call $g2w (local.get $buf)) (local.get $max)))

  (func $handle_GetWindowTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $window_text_ansi
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; GetClassNameA(hwnd, lpClassName, nMaxCount) → chars copied
  (func $handle_GetClassNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_get_window_class
      (local.get $arg0) (call $g2w (local.get $arg1)) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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
  ;; A dialog item's text as ANSI, into the guest buffer $buf ($max bytes).
  ;; Both spellings of GetDlgItemText ask the control the same question and
  ;; differ only in the encoding they hand back.
  (func $dlg_item_text_ansi (param $hdlg i32) (param $id i32) (param $buf i32) (param $max i32) (result i32)
    (local $ctrl i32)
    (local.set $ctrl (call $ctrl_find_by_id (local.get $hdlg) (local.get $id)))
    (if (local.get $ctrl)
      (then (return (call $wnd_send_message (local.get $ctrl)
              (i32.const 0x000D)              ;; WM_GETTEXT
              (local.get $max)                ;; nMaxCount
              (local.get $buf)))))            ;; lpString (guest ptr)
    ;; Empty string on miss, matching Win32. NOTE: i32.and is BITWISE — for
    ;; a logical "ptr non-null AND len > 0" coerce both sides to 0/1 first,
    ;; otherwise an even-aligned ptr & 1 = 0 and the null-terminator never lands.
    (if (i32.and (i32.ne (local.get $buf) (i32.const 0))
                 (i32.gt_u (local.get $max) (i32.const 0)))
      (then (i32.store8 (call $g2w (local.get $buf)) (i32.const 0))))
    (i32.const 0))

  (func $handle_GetDlgItemTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $dlg_item_text_ansi
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
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
    ;; Look up real HWND from the control table. Returning a fabricated HWND
    ;; makes later APIs like SetWindowTextA report success against a non-window,
    ;; which hides missing-template/control bugs from the app.
    (local.set $result (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (global.set $eax (local.get $result))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 97: GetCursorPos
  (func $handle_GetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pos i32)
    (local $x i32)
    (local $y i32)
    (local.set $pos (call $host_get_mouse_position))
    (local.set $x (i32.and (local.get $pos) (i32.const 0xFFFF)))
    (local.set $y (i32.and (i32.shr_u (local.get $pos) (i32.const 16)) (i32.const 0xFFFF)))
    (global.set $last_msg_pos_x (local.get $x))
    (global.set $last_msg_pos_y (local.get $y))
    (call $gs32 (local.get $arg0) (local.get $x))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (local.get $y))
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

  ;; 100: ReleaseDC(hwnd, hdc) — release the WAT-owned DC, return 1.
  (func $handle_ReleaseDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_release_dc (local.get $arg1)))
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
        ;; Top-level placeholders have no previous guest proc. Native controls,
        ;; however, must return the built-in sentinel so subclasses can chain
        ;; stateful messages through CallWindowProc.
        (if (i32.and
              (i32.eq (global.get $eax) (global.get $WNDPROC_BUILTIN))
              (i32.eqz (call $ctrl_table_get_class (local.get $arg0))))
          (then (global.set $eax (i32.const 0))))
        ;; If old wndproc is 0 (not in table), fall back to global wndproc for main window
        (if (i32.and (i32.eqz (global.get $eax))
                     (i32.eq (local.get $arg0) (global.get $main_hwnd)))
          (then (global.set $eax (global.get $wndproc_addr))))
        ;; WAT-native trackbars already implement the common-control messages
        ;; Funtris uses. Letting the app replace their wndproc routes every
        ;; initialization SendMessage through an x86 subclass chain that never
        ;; reaches browser-idle again, so keep the native wndproc installed.
        (if (i32.eq (call $ctrl_table_get_class (local.get $arg0)) (i32.const 19))
          (then
            (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
            (return)))
        (call $wnd_table_set (local.get $arg0) (local.get $arg2)) ;; set new wndproc
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -12))  ;; GWL_ID
      (then
        (global.set $eax
          (call $ctrl_table_set_id (local.get $arg0) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $arg1) (i32.const -16))  ;; GWL_STYLE
      (then
        (global.set $eax (call $wnd_set_style (local.get $arg0) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; Dialog and registered-window extra bytes are independent of application
    ;; GWL_USERDATA. WinHelp's toolbar uses multiple positive LONG offsets.
    (if (i32.ge_s (local.get $arg1) (i32.const 0))
      (then
        (if (call $dialog_proc_get (local.get $arg0))
          (then
            (global.set $eax (call $dialog_extra_set
              (local.get $arg0) (local.get $arg1) (local.get $arg2))))
          (else
            (global.set $eax (call $wnd_extra_set
              (local.get $arg0) (local.get $arg1) (local.get $arg2)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; Default: return 0 for unhandled indices
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; SetWindowWord(hWnd, nIndex, wNewWord) → WORD (previous value)
  ;;
  ;; Win16's window-word API, still exported by USER32 and still used: Win98's
  ;; System Monitor calls it for View > Hide Title Bar, and with no entry point
  ;; registered that menu item was a hard fail-fast crash.
  ;;
  ;; A negative index names the same field as SetWindowLong -- GWL_WNDPROC -4,
  ;; GWL_ID -12, GWL_STYLE -16 and friends -- so hand those to the 32-bit
  ;; handler and narrow the result, rather than keeping a second copy of that
  ;; logic. Both are stdcall(3), so it pops the frame correctly for us too.
  ;;
  ;; A non-negative index is a byte offset into the window's extra bytes, and
  ;; the whole point of this call is that it touches exactly two of them:
  ;; widening it to a dword store would silently clobber the neighbouring word.
  (func $handle_SetWindowWord (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $p i32) (local $old i32)
    (if (i32.lt_s (local.get $arg1) (i32.const 0))
      (then
        (call $handle_SetWindowLongA
          (local.get $arg0) (local.get $arg1)
          (i32.and (local.get $arg2) (i32.const 0xFFFF))
          (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
        (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (return)))
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    ;; 16 bytes of extra storage per window; a word needs both of its bytes
    ;; inside it.
    (if (i32.or (i32.lt_s (local.get $slot) (i32.const 0))
                (i32.gt_u (local.get $arg1) (i32.const 14)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $p (call $wnd_extra_addr (local.get $slot) (local.get $arg1)))
    (local.set $old (i32.load16_u (local.get $p)))
    (i32.store16 (local.get $p) (i32.and (local.get $arg2) (i32.const 0xFFFF)))
    (global.set $eax (local.get $old))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 102: SetWindowTextA
  (func $handle_SetWindowTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $len i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $len (call $guest_strlen (local.get $arg1)))
    ;; Child controls treat SetWindowText as WM_SETTEXT on their own wndproc.
    ;; Top-level dialogs/windows still update the caption title table below.
    (if (i32.and
          (call $ctrl_table_get_class (local.get $arg0))
          (i32.or
            (i32.lt_u (call $ctrl_table_get_class (local.get $arg0)) (i32.const 10))
            (i32.gt_u (call $ctrl_table_get_class (local.get $arg0)) (i32.const 16))))
      (then
        (global.set $eax (call $control_wndproc_dispatch
          (local.get $arg0) (i32.const 0x000C) (i32.const 0) (local.get $arg1)))
        (call $host_set_window_text (local.get $arg0) (local.get $wa))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; Native child windows such as RichEdit20A are not WAT control-table
    ;; controls, but SetWindowText still maps to WM_SETTEXT for them. Without
    ;; this, WordPad's File->New title reset succeeds while the RichEdit buffer
    ;; keeps the previous document text.
    (if (i32.and
          (i32.ne (call $wnd_get_parent (local.get $arg0)) (i32.const 0))
          (i32.ne (call $wnd_table_get (local.get $arg0)) (i32.const 0)))
      (then
        (call $richedit_format_reset_hwnd (local.get $arg0))
        (call $title_table_set (local.get $arg0) (local.get $wa) (local.get $len))
        (global.set $eax (call $wnd_send_message
          (local.get $arg0) (i32.const 0x000C) (i32.const 0) (local.get $arg1)))
        (call $host_set_window_text (local.get $arg0) (local.get $wa))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; Store in TITLE_TABLE so DefWindowProc WM_NCPAINT can redraw the
    ;; caption text from WAT-side state. Also post WM_NCPAINT.
    (call $title_table_set (local.get $arg0) (local.get $wa) (local.get $len))
    (call $nc_flags_set (local.get $arg0) (i32.const 1))
    ;; SetWindowText can run inside a synchronous common-dialog hook, where
    ;; the normal deferred NC-paint scan cannot run until after the modal
    ;; frame is already exposed. Paint the new caption immediately as USER does.
    (call $defwndproc_do_ncpaint (local.get $arg0))
    (call $host_set_window_text (local.get $arg0) (local.get $wa))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 103: SetDlgItemTextA — delegate to the control's wndproc via
  ;; WM_SETTEXT so EditState / ButtonState / StaticState own the string.
  (func $handle_SetDlgItemTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ctrl i32) (local $wa i32) (local $len i32)
    (local.set $ctrl (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $ctrl)
      (then
        ;; USER's window text is independent of the class wndproc. Registered
        ;; dialog controls such as Sound Recorder's noflicker readout query it
        ;; through GetWindowTextA while painting.
        (if (local.get $arg2)
          (then
            (local.set $wa (call $g2w (local.get $arg2)))
            (local.set $len (call $strlen (local.get $wa)))))
        (call $title_table_set (local.get $ctrl) (local.get $wa) (local.get $len))
        (drop (call $wnd_send_message (local.get $ctrl)
                (i32.const 0x000C)                    ;; WM_SETTEXT
                (i32.const 0)
                (local.get $arg2)))))                 ;; lpString (guest ptr)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 104: SetDlgItemInt(hDlg, nIDDlgItem, uValue, bSigned) — format integer
  ;; into decimal ASCII and delegate to WM_SETTEXT on the child edit.
  (func $handle_SetDlgItemInt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ctrl i32) (local $buf i32) (local $buf_w i32)
    (local $val i32) (local $neg i32) (local $tmp i32)
    (local $digits i32) (local $i i32)
    (local.set $ctrl (call $ctrl_find_by_id (local.get $arg0) (local.get $arg1)))
    (if (local.get $ctrl)
      (then
        (local.set $val (local.get $arg2))
        (local.set $neg (i32.const 0))
        (if (i32.and (i32.ne (local.get $arg3) (i32.const 0))
                     (i32.lt_s (local.get $val) (i32.const 0)))
          (then
            (local.set $neg (i32.const 1))
            (local.set $val (i32.sub (i32.const 0) (local.get $val)))))
        ;; 16-byte scratch is plenty: max 10 digits + sign + NUL
        (local.set $buf (call $heap_alloc (i32.const 16)))
        (if (local.get $buf)
          (then
            (local.set $buf_w (call $g2w (local.get $buf)))
            ;; Count digits (at least 1 for val==0)
            (local.set $tmp (local.get $val))
            (local.set $digits (i32.const 1))
            (block $cnt_done (loop $cnt
              (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
              (br_if $cnt_done (i32.eqz (local.get $tmp)))
              (local.set $digits (i32.add (local.get $digits) (i32.const 1)))
              (br $cnt)))
            ;; Write sign if needed
            (if (local.get $neg)
              (then
                (i32.store8 (local.get $buf_w) (i32.const 0x2D))  ;; '-'
                (local.set $buf_w (i32.add (local.get $buf_w) (i32.const 1)))))
            ;; Emit digits right-to-left
            (local.set $i (i32.sub (local.get $digits) (i32.const 1)))
            (local.set $tmp (local.get $val))
            (block $emit_done (loop $emit
              (i32.store8
                (i32.add (local.get $buf_w) (local.get $i))
                (i32.add (i32.const 0x30) (i32.rem_u (local.get $tmp) (i32.const 10))))
              (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
              (br_if $emit_done (i32.eqz (local.get $i)))
              (local.set $i (i32.sub (local.get $i) (i32.const 1)))
              (br $emit)))
            ;; NUL terminator
            (i32.store8 (i32.add (local.get $buf_w) (local.get $digits)) (i32.const 0))
            (drop (call $wnd_send_message (local.get $ctrl)
                    (i32.const 0x000C)          ;; WM_SETTEXT
                    (i32.const 0)
                    (local.get $buf)))
            (call $heap_free (local.get $buf)))))
      )
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; 105: SetForegroundWindow(hWnd) — 1 arg stdcall
  (func $handle_SetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_activate_window (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; SwitchToThisWindow(hWnd, fAltTab) — activate renderer window
  (func $handle_SwitchToThisWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_activate_window (local.get $arg0)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; CloseWindow(hWnd) — despite the name, Win32 minimizes the window.
  (func $handle_CloseWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $host_show_window (local.get $arg0) (i32.const 6))) ;; SW_MINIMIZE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CascadeWindows(hwndParent, how, lpRect, cKids, lpKids) → arranged count.
  (func $handle_CascadeWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_arrange_windows
      (i32.const 0) (local.get $arg1)
      (select (call $g2w (local.get $arg2)) (i32.const 0) (i32.ne (local.get $arg2) (i32.const 0)))
      (local.get $arg3)
      (select (call $g2w (local.get $arg4)) (i32.const 0) (i32.ne (local.get $arg4) (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; TileWindows(hwndParent, how, lpRect, cKids, lpKids) → arranged count.
  (func $handle_TileWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_arrange_windows
      (i32.const 1) (local.get $arg1)
      (select (call $g2w (local.get $arg2)) (i32.const 0) (i32.ne (local.get $arg2) (i32.const 0)))
      (local.get $arg3)
      (select (call $g2w (local.get $arg4)) (i32.const 0) (i32.ne (local.get $arg4) (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ArrangeIconicWindows(hwndParent) → height occupied by icon rows.
  (func $handle_ArrangeIconicWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_arrange_windows
      (i32.const 2) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

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
    ;; Dialog HWNDs keep USER's DefDlgProc marker in the window table, while
    ;; their real guest DLGPROC lives in dialog state.  The marker is below the
    ;; WAT-native range, so the generic x86 branch would otherwise jump to
    ;; 0xFFFE0002 and decode emulator-private data as guest instructions.
    (if (i32.eq (local.get $wndproc) (global.get $WNDPROC_DIALOG))
      (then
        (drop (call $dialog_default_proc
          (local.get $arg0) (i32.const 0x0007) (local.get $prev) (i32.const 0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
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
    ;; Keep SetFocus's return value and the nonvolatile register set in a
    ;; continuation frame below its original two-word stdcall frame.
    (if (local.get $wndproc)
      (then
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 40)))
        (call $gs32 (global.get $esp) (global.get $setfocus_ret_thunk))
        (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $arg0))     ;; hwnd
        (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (i32.const 0x0007))    ;; WM_SETFOCUS
        (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $prev))    ;; wParam = prev focus
        (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (i32.const 0))        ;; lParam = 0
        (call $gs32 (i32.add (global.get $esp) (i32.const 20)) (local.get $ret_addr))
        (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $prev))
        (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (global.get $ebx))
        (call $gs32 (i32.add (global.get $esp) (i32.const 32)) (global.get $esi))
        (call $gs32 (i32.add (global.get $esp) (i32.const 36)) (global.get $edi))
        (call $gs32 (i32.add (global.get $esp) (i32.const 40)) (global.get $ebp))
        (global.set $eip (local.get $wndproc))
        (global.set $steps (i32.const 0))
        (return)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 108: LoadCursorA(hInstance, lpCursorName) — return HCURSOR encoding the IDC_*.
  ;; System cursors: hInstance=0, lpCursorName is an ordinal (MAKEINTRESOURCE,
  ;; value < 0x10000) in the IDC_* range (32512..). Encoded handle:
  ;;   0x60000 | (IDC_X & 0xFFFF) — system IDC cursor.
  ;;   0x680000 | (resource & 0xFFFF) — app RT_GROUP_CURSOR resource.
  (func $handle_LoadCursorA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (i32.eqz (local.get $arg0))
                 (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
      (then (global.set $eax (i32.or (i32.const 0x60000)
                                     (i32.and (local.get $arg1) (i32.const 0xFFFF)))))
      (else
        (if (i32.lt_u (local.get $arg1) (i32.const 0x10000))
          (then (global.set $eax (i32.or (i32.const 0x680000)
                                         (i32.and (local.get $arg1) (i32.const 0xFFFF)))))
          (else (global.set $eax (i32.const 0x67F00)))))) ;; string cursor names unsupported
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ---- ICON_TABLE: HICON → the resource it was loaded from ----
  ;; An icon handle used to be the constant 0x60001, which meant DrawIconEx
  ;; had nothing to draw and every icon in the system was the same nothing.
  ;; Remembering {hInstance, resource id} is the whole difference: the pixels
  ;; are already decodable from the PE by $gdi_icon_draw_resource_at.
  (func $icon_intern (param $hinst i32) (param $resid i32) (result i32)
    (local $i i32) (local $p i32) (local $free i32)
    (local.set $free (i32.const -1))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_ICONS)))
      (local.set $p (i32.add (global.get $ICON_TABLE)
                     (i32.mul (local.get $i) (i32.const 8))))
      ;; A repeat load of the same resource must hand back the same handle:
      ;; apps compare HICONs, and DestroyIcon on a duplicate is common.
      (if (i32.and (i32.eq (i32.load (local.get $p)) (local.get $hinst))
                   (i32.eq (i32.load offset=4 (local.get $p)) (local.get $resid)))
        (then (return (i32.or (global.get $ICON_HANDLE_TAG) (local.get $i)))))
      (if (i32.and (i32.lt_s (local.get $free) (i32.const 0))
                   (i32.eqz (i32.load offset=4 (local.get $p))))
        (then (local.set $free (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.lt_s (local.get $free) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $p (i32.add (global.get $ICON_TABLE)
                   (i32.mul (local.get $free) (i32.const 8))))
    (i32.store (local.get $p) (local.get $hinst))
    (i32.store offset=4 (local.get $p) (local.get $resid))
    (i32.or (global.get $ICON_HANDLE_TAG) (local.get $free)))

  ;; Paint an interned icon. Returns 0 for any handle we did not intern, which
  ;; keeps the old opaque handles (and system icons we ship no pixels for)
  ;; behaving exactly as before instead of drawing garbage.
  (func $icon_draw_handle (param $hicon i32) (param $hdc i32)
        (param $x i32) (param $y i32) (param $cx i32) (param $cy i32)
        (param $di_flags i32) (result i32)
    (local $slot i32) (local $p i32) (local $ok i32)
    (if (i32.ne (i32.and (local.get $hicon) (i32.const 0xFFFF0000))
                (global.get $ICON_HANDLE_TAG))
      (then (return (i32.const 0))))
    (local.set $slot (i32.and (local.get $hicon) (i32.const 0xFFFF)))
    (if (i32.ge_u (local.get $slot) (global.get $MAX_ICONS))
      (then (return (i32.const 0))))
    (local.set $p (i32.add (global.get $ICON_TABLE)
                   (i32.mul (local.get $slot) (i32.const 8))))
    (if (i32.eqz (i32.load offset=4 (local.get $p)))
      (then (return (i32.const 0))))
    ;; cx/cy of 0 mean "the icon's own size" — the DrawIconEx default.
    (if (i32.le_s (local.get $cx) (i32.const 0))
      (then (local.set $cx (i32.const 32))))
    (if (i32.le_s (local.get $cy) (i32.const 0))
      (then (local.set $cy (i32.const 32))))
    ;; The icon belongs to the module it was loaded from, which need not be
    ;; the one running now.
    (call $push_rsrc_ctx (i32.load (local.get $p)))
    (local.set $ok (call $gdi_icon_draw_resource_at
      (local.get $hdc) (i32.load offset=4 (local.get $p))
      (local.get $cx) (local.get $cy) (i32.const 1)
      (local.get $x) (local.get $y) (local.get $di_flags)))
    (call $pop_rsrc_ctx)
    (local.get $ok))

  ;; 109: LoadIconA(hInstance, lpIconName)
  (func $handle_LoadIconA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Named (string-pointer) icon resources are not interned: the resource
    ;; walker addresses RT_GROUP_ICON by ordinal. Those keep the old opaque
    ;; handle rather than a slot that would decode to the wrong picture.
    (if (i32.and (i32.ne (local.get $arg0) (i32.const 0))
                 (i32.le_u (local.get $arg1) (i32.const 0xFFFF)))
      (then
        (global.set $eax (call $icon_intern (local.get $arg0) (local.get $arg1)))
        (if (global.get $eax)
          (then (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
                (return)))))
    (global.set $eax (i32.const 0x60001)) ;; opaque HICON, no pixels
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

  ;; 112: EnableWindow
  ;; EnableWindow(hWnd, bEnable) → BOOL (previous state)
  (func $handle_EnableWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $idx i32) (local $style i32) (local $new_style i32) (local $prev_enabled i32)
    (local.set $idx (call $wnd_table_find (local.get $arg0)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $style (call $wnd_get_style (local.get $arg0)))
    (local.set $prev_enabled
      (select (i32.const 0) (i32.const 1)
        (i32.and (local.get $style) (i32.const 0x08000000))))
    (if (local.get $arg1)
      (then
        (local.set $new_style
          (i32.and (local.get $style) (i32.const 0xF7FFFFFF))))
      (else
        (local.set $new_style
          (i32.or (local.get $style) (i32.const 0x08000000)))))
    (if (i32.ne (local.get $new_style) (local.get $style))
      (then
        (drop (call $wnd_set_style (local.get $arg0) (local.get $new_style)))
        ;; WM_ENABLE(wParam=bEnable). Most built-in controls ignore it, but
        ;; owner/subclassed windows may rely on the notification.
        (drop (call $wnd_send_message
          (local.get $arg0) (i32.const 0x000A)
          (select (i32.const 1) (i32.const 0) (local.get $arg1))
          (i32.const 0)))
        (call $invalidate_hwnd (local.get $arg0))))
    (global.set $eax (local.get $prev_enabled))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

;; 114: EndDialog(hDlg, nResult) — end modal dialog, set result
  (func $handle_EndDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; MFC also calls EndDialog on dialogs created through CreateDialogParamA.
    ;; Those modeless dialogs have no CACA0004 pump, so do not poison the
    ;; global modal-completion flags unless this hwnd is the active modal.
    (if (i32.and
          (i32.ne (global.get $dlg_pump_hwnd) (i32.const 0))
          (i32.eq (local.get $arg0) (global.get $dlg_pump_hwnd)))
      (then
        (global.set $dlg_ended (i32.const 1))
        (global.set $dlg_result (local.get $arg1))
        (i32.store (global.get $SHARED_DLG_ENDED) (i32.const 1))
        (i32.store (global.get $SHARED_DLG_RESULT) (local.get $arg1))))
    ;; Remove the visible frame here, even for DialogBoxParamA. Renderer-side
    ;; WAT dialog routing can call EndDialog synchronously while the guest is
    ;; between modal-pump turns; waiting for the pump leaves the dialog stuck
    ;; on screen. The pump cleanup path below is guarded for already-removed
    ;; dialogs.
    (if (call $wnd_table_get (local.get $arg0))
      (then
        (call $wnd_destroy_children (local.get $arg0))
        (call $wnd_table_remove (local.get $arg0))))
    (call $host_destroy_window (local.get $arg0))
    ;; Don't set quit_flag — that kills the main message loop.
    ;; CACA0004 checks dlg_ended to exit the modal loop.
    (global.set $yield_flag (i32.const 1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 115: InvalidateRect(hwnd, lprc, bErase). lprc=NULL → full client rect.
  (func $handle_InvalidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $l i32) (local $t i32) (local $r i32) (local $b i32) (local $wa i32) (local $cs i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (local.get $arg1)
      (then
        (local.set $wa (call $g2w (local.get $arg1)))
        (local.set $l (i32.load (local.get $wa)))
        (local.set $t (i32.load offset=4 (local.get $wa)))
        (local.set $r (i32.load offset=8 (local.get $wa)))
        (local.set $b (i32.load offset=12 (local.get $wa))))
      (else
        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
        (local.set $l (i32.const 0)) (local.set $t (i32.const 0))
        (local.set $r (i32.and (local.get $cs) (i32.const 0xFFFF)))
        (local.set $b (i32.shr_u (local.get $cs) (i32.const 16)))))
    (call $update_invalidate_rect (local.get $arg0) (local.get $l) (local.get $t) (local.get $r) (local.get $b))
    ;; bErase is deliberately not turned into a queued WM_ERASEBKGND here.
    ;; Windows erases from inside BeginPaint, in the same breath as the paint;
    ;; a separately queued erase arrives whenever the pump gets to it, and Hearts
    ;; draws a dealt hand with its own DC outside WM_PAINT -- so the erase landed
    ;; after the cards and wiped four of them off the table. See $handle_BeginPaint
    ;; for where the background is decided instead.
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
      (then (global.set $paint_pending (i32.const 1)))
      (else (call $paint_flag_set (local.get $arg0))))
    (call $host_invalidate (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 116: FillRect(hdc, lprc, hbr)
  (func $handle_FillRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $rc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (local.set $rc (call $g2w (local.get $arg1)))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_fill_rect_desc
        (local.get $arg0) (local.get $desc)
        (i32.load (local.get $rc)) (i32.load offset=4 (local.get $rc))
        (i32.load offset=8 (local.get $rc)) (i32.load offset=12 (local.get $rc))
        (local.get $arg2))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 117: FrameRect(hdc, lprc, hbr) — draw 1px frame using brush
  (func $handle_FrameRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $desc i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_frame_rect_desc
        (local.get $arg0) (local.get $desc)
        (i32.load (local.get $wa)) (i32.load offset=4 (local.get $wa))
        (i32.load offset=8 (local.get $wa)) (i32.load offset=12 (local.get $wa))
        (local.get $arg2))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; stdcall, 3 args
  )

  ;; 118: LoadBitmapA
  (func $handle_LoadBitmapA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_load_resource
      (local.get $arg0) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 119: OpenIcon(hwnd) — restores a minimized window; return nonzero
  (func $handle_OpenIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 120: MoveWindow — hwnd(arg0), x(arg1), y(arg2), w(arg3), h(arg4), bRepaint=[esp+24]
  ;; Real Win32 sends WM_SIZE after resizing; store pending size for ShowWindow delivery.
  ;; A same-size MoveWindow is a geometry no-op and must not enqueue another
  ;; WM_SIZE. Some applications enforce an aspect ratio from WM_SIZE by calling
  ;; MoveWindow with the dimensions they already have; requeueing in that case
  ;; creates an infinite WM_SIZE -> MoveWindow loop and starves paint/timers.
  (func $handle_MoveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cx i32) (local $cy i32) (local $cs i32) (local $old_cs i32) (local $dlg_rec i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
    (local.set $old_cs (call $host_get_window_client_size (local.get $arg0)))
    (call $host_move_window (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (i32.const 0))
    (call $ctrl_geom_sync (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (i32.const 0))
    (call $defwndproc_do_nccalcsize (local.get $arg0))
    (call $host_sync_window_client
      (local.get $arg0)
      (call $wnd_client_screen_x (local.get $arg0))
      (call $wnd_client_screen_y (local.get $arg0))
      (i32.sub (call $client_rect_get_r (local.get $arg0)) (call $client_rect_get_l (local.get $arg0)))
      (i32.sub (call $client_rect_get_b (local.get $arg0)) (call $client_rect_get_t (local.get $arg0))))
    (local.set $dlg_rec (call $dlg_record_for_hwnd (local.get $arg0)))
    (if (i32.and
          (i32.ne (local.get $dlg_rec) (i32.const 0))
          (i32.ne (i32.load offset=4 (local.get $dlg_rec)) (i32.const 0)))
      (then (drop (call $host_erase_background (local.get $arg0) (i32.const 16)))))
    ;; If the main window is moved/resized before its first ShowWindow, refresh
    ;; the pending WM_SIZE that was seeded during CreateWindowExA. EmPipe does
    ;; exactly this; using the stale 0x0 create size moves its controls offscreen.
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
    (then
	      (global.set $main_win_cx (local.get $arg3))
	      (global.set $main_win_cy (local.get $arg4))
	      (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
	      (if (i32.ne (local.get $cs) (local.get $old_cs))
	        (then
	          (global.set $pending_wm_size (local.get $cs))
	          (call $invalidate_hwnd (local.get $arg0)))))
	    (else
	      (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
	      (if (i32.ne (local.get $cs) (local.get $old_cs))
	        (then
	          (call $invalidate_hwnd (local.get $arg0))
              ;; Preserve every resized child instead of overwriting one global
              ;; pending HWND. Paint resizes its inner canvas during dock-bar
              ;; layout without calling ShowWindow on it afterward; the old
              ;; single-slot path therefore never delivered its final WM_SIZE.
              (drop (call $post_queue_push
                (local.get $arg0) (i32.const 0x0005)
                (i32.const 0) (local.get $cs)))))))
    (global.set $eax (i32.const 1))
    (return)
  )

 123: CheckRadioButton(hDlg, firstId, lastId, checkId) — clear all in
  ;; [firstId,lastId] and set checkId. Pure WAT path now that ButtonState
  ;; bit 1 is the source of truth.
  (func $handle_CheckRadioButton (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $id i32) (local $ctrl i32)
    (local.set $id (local.get $arg1))
    (block $done (loop $scan
      (br_if $done (i32.gt_u (local.get $id) (local.get $arg2)))
      (local.set $ctrl (call $ctrl_find_by_id (local.get $arg0) (local.get $id)))
      (if (local.get $ctrl)
        (then
          ;; Drive the real BUTTON message path so ButtonState.flags,
          ;; CONTROL_TABLE fallback state, invalidation, and immediate repaint
          ;; stay in sync. Calc relies on CheckRadioButton after BN_CLICKED.
          (drop (call $wnd_send_message
            (local.get $ctrl)
            (i32.const 0x00F1) ;; BM_SETCHECK
            (select (i32.const 1) (i32.const 0)
              (i32.eq (local.get $id) (local.get $arg3)))
            (i32.const 0)))))
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

  ;; 129: ChildWindowFromPoint(hWndParent, POINT). POINT is passed by value.
  ;; Convert the parent-client point to screen coordinates and use the shared
  ;; HWND-tree hit tester. Win32 returns the parent when no child contains it.
  (func $handle_ChildWindowFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $child i32)
    (local.set $child (call $wnd_child_from_point_deep
      (local.get $arg0)
      (i32.add (call $wnd_client_screen_x (local.get $arg0)) (local.get $arg1))
      (i32.add (call $wnd_client_screen_y (local.get $arg0)) (local.get $arg2))))
    (global.set $eax
      (select (local.get $child) (local.get $arg0) (local.get $child)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 130: ScreenToClient
  (func $handle_ScreenToClient (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pt i32) (local $ox i32) (local $oy i32)
    (local.set $pt (call $g2w (local.get $arg1)))
    (local.set $ox (call $wnd_client_screen_x (local.get $arg0)))
    (local.set $oy (call $wnd_client_screen_y (local.get $arg0)))
    (i32.store (local.get $pt)
      (i32.sub (i32.load (local.get $pt)) (local.get $ox)))
    (i32.store offset=4 (local.get $pt)
      (i32.sub (i32.load offset=4 (local.get $pt)) (local.get $oy)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

;; 132: WinHelpA(hwnd, lpszHelp, uCommand, dwData) — unified WAT dispatcher
  (func $handle_WinHelpA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $accepted i32)
    (local.set $accepted (call $help_dispatch_api_a
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (call $help_present_dispatch (local.get $accepted) (local.get $arg2))
    (global.set $eax (local.get $accepted))
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
    (global.set $eax (call $host_gdi_create_solid_brush (call $win98_sys_color (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 135: GetSysColor
  (func $handle_GetSysColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $win98_sys_color (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 136: DialogBoxParamA(hInstance, lpTemplate, hWndParent, lpDialogFunc, dwInitParam)
  ;; DialogBoxParamA(hInstance, lpTemplateName, hWndParent, lpDialogFunc, dwInitParam)
  ;; Creates modal dialog, sends WM_INITDIALOG, enters message loop, returns EndDialog result
  (func $handle_DialogBoxParamA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32) (local $init_param i32)
    (local $dlg_rec i32) (local $ctrl_count i32) (local $i i32) (local $ctrl_hwnd i32)
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
    (i32.store (global.get $SHARED_DLG_ENDED) (i32.const 0))
    (i32.store (global.get $SHARED_DLG_RESULT) (i32.const 0))
    (global.set $dlg_proc (local.get $arg3))
    ;; USER keeps the DLGPROC separate from the dialog window's DefDlgProc
    ;; WNDPROC. This is observable when a framework subclasses the dialog and
    ;; chains to the saved previous procedure.
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (drop (call $dialog_proc_set (local.get $hwnd) (local.get $arg3)))
    ;; Parse the RT_DIALOG template fully in WAT — allocates child hwnds,
    ;; fills CONTROL_TABLE + CONTROL_GEOM, sends WM_CREATE, stores header
    ;; state in WND_DLG_RECORDS[slot]. Handles int IDs and guest string
    ;; pointers (named entries) via $find_resource. Route resource lookup
    ;; through hInstance so templates in a satellite DLL resolve.
    (call $push_rsrc_ctx (local.get $arg0))
    (drop (call $dlg_load (local.get $hwnd) (local.get $arg1)))
    (call $pop_rsrc_ctx)
    ;; DialogBoxParam creates a top-level owned dialog and shows it before
    ;; WM_INITDIALOG. Template styles commonly omit WS_VISIBLE; USER's modal
    ;; creation path still makes the HWND visible, so keep WAT style in sync
    ;; before visibility-dependent hit-testing/painting runs.
    (call $wnd_set_parent (local.get $hwnd) (i32.const 0))
    (call $wnd_set_owner (local.get $hwnd) (local.get $arg2))
    (drop (call $wnd_set_style (local.get $hwnd)
      (i32.or (call $wnd_get_style (local.get $hwnd)) (i32.const 0x10000000))))
    ;; Tell the renderer the dialog has been loaded; JS reads geom /
    ;; style / controls from the dlg_* / ctrl_* exports.
    (call $host_dialog_loaded (local.get $hwnd) (local.get $arg2))
    ;; Populate WAT CLIENT_RECT from the same frame metrics the renderer
    ;; uses so ScreenToClient/MapWindowPoints subtract the real client origin.
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    ;; Fill dialog client area with COLOR_BTNFACE — template DlgProcs
    ;; typically don't handle WM_PAINT, expecting DefDlgProc to erase,
    ;; but our modal pump doesn't fall through to DefWindowProc on a
    ;; FALSE return from WM_PAINT. Without this, the back-canvas stays
    ;; transparent/teal between control bodies.
    (call $dlg_fill_bkgnd (local.get $hwnd))
    ;; Seed WM_NCPAINT so the modal pump delivers chrome paint to the
    ;; dialog's wndproc → DefDlgProc/DefWindowProc → back-canvas chrome.
    ;; Without this, modal dialogs stay chrome-less in the PNG.
    (call $nc_flags_set (local.get $hwnd) (i32.const 1))
    ;; Enqueue WM_PAINT for each child control. Mirrors CreateDialogParamA;
    ;; otherwise buttons/edits/statics never get their first WM_PAINT while
    ;; the modal pump runs. Walk via $wnd_next_child_slot rather than
    ;; assuming contiguous hwnd allocation — combobox WM_CREATE may
    ;; allocate auxiliary windows (inner listbox, WS_POPUP shell) that
    ;; punch holes in the dlg_hwnd+1..dlg_hwnd+ctrl_count range.
    (local.set $i (i32.const 0))
    (block $done (loop $push_loop
      (local.set $i (call $wnd_next_child_slot (local.get $hwnd) (local.get $i)))
      (br_if $done (i32.eq (local.get $i) (i32.const -1)))
      (local.set $ctrl_hwnd (call $wnd_slot_hwnd (local.get $i)))
      (if (i32.and (call $wnd_get_style (local.get $ctrl_hwnd)) (i32.const 0x10000000))
        (then (call $paint_flag_set_inv (local.get $ctrl_hwnd))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $push_loop)))
    ;; Do not synchronously paint children during DialogBoxParamA creation.
    ;; The modal pump below drains seeded WAT-native paints after the dialog
    ;; is visible and its USER-style visible region is stable.
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
    (global.set $dlg_init_focus_hwnd (global.get $focus_hwnd))
    (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (global.get $dlg_init_focus_hwnd)) ;; wParam (focus hwnd)
    (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $init_param))   ;; lParam
    ;; Set EIP to dialog proc and signal redirection (don't let caller override EIP)
    (global.set $eip (local.get $arg3))
    ;; Let the host observe/show the modal shell before WM_INITDIALOG starts,
    ;; then yield once more when that guest callback returns to CACA0004.
    (global.set $dlg_callback_yield_pending (i32.const 1))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0))
  )

  ;; DialogBoxParamW — same as A. Template names, if strings, are UTF-16,
  ;; but $find_resource only matches integer IDs and ASCII strings, so
  ;; UTF-16 string templates fall to the int branch either way (like
  ;; CreateDialogParamW). Winmine's Custom dialog uses int IDs (0x5A).
  (func $handle_DialogBoxParamW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (call $handle_DialogBoxParamA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
    (call $wnd_unicode_set (local.get $hwnd) (i32.const 1))
  )

 139: OffsetRect — STUB: unimplemented
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
  ;; Translate an array of POINTs from hWndFrom's client space into hWndTo's.
  ;; hWndFrom/hWndTo==NULL means screen coordinates. Return packs dx/dy in
  ;; signed 16-bit halves, matching the Win32 contract.
  (func $handle_MapWindowPoints (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dx i32) (local $dy i32)
    (local $i i32) (local $p i32)
    (local.set $dx (i32.sub
      (call $wnd_client_screen_x (local.get $arg0))
      (call $wnd_client_screen_x (local.get $arg1))))
    (local.set $dy (i32.sub
      (call $wnd_client_screen_y (local.get $arg0))
      (call $wnd_client_screen_y (local.get $arg1))))
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
  ;; WINDOWPOS structs handed to guest wndprocs by $windowpos_notify. These are
  ;; guest-visible, so they come from $heap_alloc (which returns guest
  ;; addresses) rather than one of the emulator-private scratch regions, which
  ;; live outside the g2w window and cannot be dereferenced by the guest.
  ;;
  ;; A wndproc handling WM_WINDOWPOSCHANGED routinely calls SetWindowPos again
  ;; — VCL does it while laying out children — so a single shared struct would
  ;; be rewritten underneath an outer frame that still holds the pointer. The
  ;; depth counter picks the slot and bounds the recursion in one move.
  ;; Base of the wndproc markers GetClassInfo hands out for USER's own control
  ;; classes; the low byte carries the $control_wndproc_dispatch class id.
  ;; Sits in the same reserved 0xFFFE_xxxx space as $WNDPROC_BUILTIN.
  (global $WNDPROC_SYSCLASS i32 (i32.const 0xFFFE0100))

  ;; Give a newly adopted control the WM_CREATE it never received.
  ;;
  ;; Every control proc allocates its state block in WM_CREATE, and a window
  ;; created under the app's own class name never had one routed to it. Left
  ;; alone the state pointer stays NULL and the procs then read and write
  ;; through guest address zero -- which superficially works, because both
  ;; sides use the same bad pointer, while quietly corrupting low guest
  ;; memory. Replaying creation is also how the control learns its id, caption
  ;; and button kind, none of which it can recover later.
  (global $sysclass_cs (mut i32) (i32.const 0))
  (func $sysclass_replay_create (param $hwnd i32) (param $slot i32)
    (local $cs i32) (local $cs_w i32) (local $name i32) (local $geom i32)
    (if (i32.eqz (global.get $sysclass_cs))
      ;; 48-byte CREATESTRUCT followed by the caption it points at.
      (then (global.set $sysclass_cs (call $heap_alloc (i32.const 304)))))
    (if (i32.eqz (global.get $sysclass_cs)) (then (return)))
    (local.set $cs (global.get $sysclass_cs))
    (local.set $name (i32.add (local.get $cs) (i32.const 48)))
    (local.set $cs_w (call $g2w (local.get $cs)))
    (drop (call $host_get_window_text
      (local.get $hwnd) (call $g2w (local.get $name)) (i32.const 255)))
    (local.set $geom (call $ctrl_geom_addr (local.get $slot)))
    (i32.store           (local.get $cs_w) (i32.const 0))  ;; lpCreateParams
    (i32.store offset=4  (local.get $cs_w) (i32.const 0))  ;; hInstance
    (i32.store offset=8  (local.get $cs_w) (call $ctrl_table_get_id (local.get $hwnd)))
    (i32.store offset=12 (local.get $cs_w) (call $wnd_get_parent (local.get $hwnd)))
    (i32.store offset=16 (local.get $cs_w) (i32.load16_u offset=6 (local.get $geom)))
    (i32.store offset=20 (local.get $cs_w) (i32.load16_u offset=4 (local.get $geom)))
    (i32.store offset=24 (local.get $cs_w) (i32.load16_u offset=2 (local.get $geom)))
    (i32.store offset=28 (local.get $cs_w) (i32.load16_u (local.get $geom)))
    (i32.store offset=32 (local.get $cs_w) (call $wnd_get_style (local.get $hwnd)))
    (i32.store offset=36 (local.get $cs_w) (local.get $name))
    (i32.store offset=40 (local.get $cs_w) (i32.const 0))  ;; lpszClass
    (i32.store offset=44 (local.get $cs_w) (call $ctrl_get_ex_style (local.get $hwnd)))
    (drop (call $control_wndproc_dispatch
      (local.get $hwnd) (i32.const 0x0001) (i32.const 0) (local.get $cs))))

  (global $windowpos_ring (mut i32) (i32.const 0))
  (global $windowpos_depth (mut i32) (i32.const 0))
  (global $WINDOWPOS_SLOT i32 (i32.const 32))   ;; 28-byte struct, padded
  (global $WINDOWPOS_DEPTH_MAX i32 (i32.const 8))

  ;; Tell a window it was moved or resized.
  ;;
  ;; Win32 sends this synchronously from inside SetWindowPos, and VCL depends
  ;; on that precise timing: TWinControl.SetBounds does not cache the new size
  ;; when the window has a handle. It calls SetWindowPos and lets
  ;; WM_WINDOWPOSCHANGED -> UpdateBounds -> GetWindowRect write FLeft/FTop/
  ;; FWidth/FHeight back. Without the message those fields keep whatever the
  ;; window was created with, so the next SetBounds — setting height, say —
  ;; passes a stale width alongside it and silently undoes the previous call.
  ;; Posting the message instead of sending it does not help: the whole
  ;; sequence runs before the app pumps its queue again.
  (func $windowpos_notify
    (param $hwnd i32) (param $insert_after i32) (param $x i32) (param $y i32)
    (param $cx i32) (param $cy i32) (param $flags i32)
    (local $wp i32) (local $slot i32) (local $w i32)
    (local.set $wp (call $wnd_table_get (local.get $hwnd)))
    (if (i32.eqz (local.get $wp)) (then (return)))
    ;; WAT-native and builtin procs keep their own geometry; only a guest
    ;; wndproc has bookkeeping that can drift out of sync with ours.
    (if (i32.eq (local.get $wp) (global.get $WNDPROC_BUILTIN)) (then (return)))
    (if (i32.ge_u (local.get $wp) (i32.const 0xFFFF0000)) (then (return)))
    ;; WAT-owned controls are already tracked by $ctrl_geom_sync above.
    (if (call $ctrl_table_get_class (local.get $hwnd)) (then (return)))
    (if (i32.ge_u (global.get $windowpos_depth) (global.get $WINDOWPOS_DEPTH_MAX))
      (then (return)))
    (if (i32.eqz (global.get $windowpos_ring))
      (then
        (global.set $windowpos_ring (call $heap_alloc
          (i32.mul (global.get $WINDOWPOS_SLOT) (global.get $WINDOWPOS_DEPTH_MAX))))))
    (if (i32.eqz (global.get $windowpos_ring)) (then (return)))
    (local.set $slot (i32.add (global.get $windowpos_ring)
      (i32.mul (global.get $windowpos_depth) (global.get $WINDOWPOS_SLOT))))
    (local.set $w (call $g2w (local.get $slot)))
    (i32.store (local.get $w) (local.get $hwnd))
    (i32.store offset=4 (local.get $w) (local.get $insert_after))
    (i32.store offset=8 (local.get $w) (local.get $x))
    (i32.store offset=12 (local.get $w) (local.get $y))
    (i32.store offset=16 (local.get $w) (local.get $cx))
    (i32.store offset=20 (local.get $w) (local.get $cy))
    (i32.store offset=24 (local.get $w) (local.get $flags))
    (global.set $windowpos_depth (i32.add (global.get $windowpos_depth) (i32.const 1)))
    (drop (call $wnd_send_message
      (local.get $hwnd) (i32.const 0x0047) (i32.const 0) (local.get $slot)))
    (global.set $windowpos_depth (i32.sub (global.get $windowpos_depth) (i32.const 1)))
  )

  (func $handle_SetWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetWindowPos(hwnd, hWndInsertAfter, X, Y, cx, cy, uFlags)
    (local $cy i32) (local $uFlags i32) (local $dlg_rec i32)
    (local.set $cy (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $uFlags (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    ;; Pass uFlags to host so it can respect SWP_NOSIZE/SWP_NOMOVE independently
    (call $host_move_window (local.get $arg0) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $cy) (local.get $uFlags))
    (call $ctrl_geom_sync (local.get $arg0) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $cy) (local.get $uFlags))
    ;; Keep WAT's GWL_STYLE in sync with SetWindowPos visibility flags. Apps
    ;; such as Tetravex show custom child panels via SWP_SHOWWINDOW instead of
    ;; ShowWindow; if WS_VISIBLE stays clear here, WAT's paint selector treats
    ;; their later InvalidateRect calls as hidden-window work and drops them.
    (if (i32.and (local.get $uFlags) (i32.const 0x0040)) ;; SWP_SHOWWINDOW
      (then
        (drop (call $wnd_set_style (local.get $arg0)
          (i32.or (call $wnd_get_style (local.get $arg0)) (i32.const 0x10000000))))
        (if (i32.eqz (i32.and (local.get $uFlags) (i32.const 0x0008))) ;; !SWP_NOREDRAW
          (then
            (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
              (then
                (global.set $paint_pending (i32.const 1))
                (call $update_invalidate_full (local.get $arg0))
                ;; SWP_SHOWWINDOW: the frame itself is appearing, so the
                ;; non-client area needs painting, not just a composite.
                (call $host_invalidate_frame (local.get $arg0)))
              (else (call $paint_flag_set_inv (local.get $arg0))))))))
    (if (i32.and (local.get $uFlags) (i32.const 0x0080)) ;; SWP_HIDEWINDOW
      (then
        (drop (call $wnd_set_style (local.get $arg0)
          (i32.and (call $wnd_get_style (local.get $arg0)) (i32.const 0xEFFFFFFF))))
        (call $paint_clear_subtree (local.get $arg0))))
    (call $defwndproc_do_nccalcsize (local.get $arg0))
    (call $host_sync_window_client
      (local.get $arg0)
      (call $wnd_client_screen_x (local.get $arg0))
      (call $wnd_client_screen_y (local.get $arg0))
      (i32.sub (call $client_rect_get_r (local.get $arg0)) (call $client_rect_get_l (local.get $arg0)))
      (i32.sub (call $client_rect_get_b (local.get $arg0)) (call $client_rect_get_t (local.get $arg0))))
    ;; Repaint a moved WAT-native control immediately, but only if it is
    ;; actually on screen. Its own WS_VISIBLE bit is not enough: a control
    ;; inside a hidden dialog page keeps that bit set, and painting it writes
    ;; onto the top-level back-canvas at a position the page is about to leave,
    ;; where nothing will erase it. $handle_DeferWindowPos already tests it
    ;; this way.
    (if (i32.and
          (i32.ne (call $ctrl_table_get_class (local.get $arg0)) (i32.const 0))
          (call $wnd_is_effectively_visible (local.get $arg0)))
      (then
        (drop (call $control_wndproc_dispatch
          (local.get $arg0) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))
    (if (i32.eqz (i32.and (local.get $uFlags) (i32.const 0x0008))) ;; !SWP_NOREDRAW
      (then
        (local.set $dlg_rec (call $dlg_record_for_hwnd (local.get $arg0)))
        (if (i32.and
              (i32.ne (local.get $dlg_rec) (i32.const 0))
              (i32.ne (i32.load offset=4 (local.get $dlg_rec)) (i32.const 0)))
          (then (drop (call $host_erase_background (local.get $arg0) (i32.const 16)))))))
    ;; Last, so the window sees the geometry we have already committed.
    (call $windowpos_notify (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $cy) (local.get $uFlags))
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

  ;; DrawTextEx applies DRAWTEXTPARAMS around the common DrawText backend.
  ;; Margins are logical rectangle units; the tab length is an average-cell
  ;; count consumed directly by the WAT bitmap layout without overlapping the
  ;; legacy DrawText DT_TABSTOP bits.
  (func $draw_text_ex (param $hdc i32) (param $text_guest i32) (param $count i32)
        (param $rect_guest i32) (param $format i32) (param $params_guest i32)
        (param $wide i32) (result i32)
    (local $text i32) (local $rect i32) (local $params i32) (local $valid i32)
    (local $left i32) (local $top i32) (local $right i32) (local $bottom i32)
    (local $left_margin i32) (local $right_margin i32) (local $tab_chars i32)
    (local $result i32) (local $drawn i32) (local $calculated_right i32)
    (local.set $text (call $g2w (local.get $text_guest)))
    (local.set $rect (call $g2w (local.get $rect_guest)))
    (if (local.get $params_guest)
      (then
        (local.set $params (call $g2w (local.get $params_guest)))
        (local.set $valid (i32.ge_u (i32.load (local.get $params)) (i32.const 20)))))
    (if (i32.and (local.get $valid) (i32.ne (local.get $rect_guest) (i32.const 0)))
      (then
        (local.set $left (i32.load (local.get $rect)))
        (local.set $top (i32.load offset=4 (local.get $rect)))
        (local.set $right (i32.load offset=8 (local.get $rect)))
        (local.set $bottom (i32.load offset=12 (local.get $rect)))
        (local.set $left_margin (i32.load offset=8 (local.get $params)))
        (local.set $right_margin (i32.load offset=12 (local.get $params)))
        (i32.store (local.get $rect) (i32.add (local.get $left) (local.get $left_margin)))
        (i32.store offset=8 (local.get $rect)
          (i32.sub (local.get $right) (local.get $right_margin)))))
    (if (i32.and (local.get $valid)
          (i32.ne (i32.and (local.get $format) (i32.const 0x40)) (i32.const 0)))
      (then
        (local.set $tab_chars (i32.load offset=4 (local.get $params)))
        (if (i32.lt_s (local.get $tab_chars) (i32.const 0))
          (then (local.set $tab_chars (i32.const 0))))
        (if (i32.gt_s (local.get $tab_chars) (i32.const 255))
          (then (local.set $tab_chars (i32.const 255))))))
    (global.set $gdi_bitmap_draw_text_tab_chars (local.get $tab_chars))
    (local.set $result (call $host_gdi_draw_text
      (local.get $hdc) (local.get $text) (local.get $count) (local.get $rect)
      (local.get $format) (local.get $wide)))
    (global.set $gdi_bitmap_draw_text_tab_chars (i32.const 0))
    (if (local.get $valid)
      (then
        (local.set $drawn (local.get $count))
        (if (i32.eq (local.get $drawn) (i32.const -1))
          (then (local.set $drawn
            (if (result i32) (local.get $wide)
              (then (call $strlen_w (local.get $text)))
              (else (call $strlen_a (local.get $text)))))))
        (if (i32.lt_s (local.get $drawn) (i32.const 0))
          (then (local.set $drawn (i32.const 0))))
        (i32.store offset=16 (local.get $params) (local.get $drawn))))
    (if (i32.and (local.get $valid) (i32.ne (local.get $rect_guest) (i32.const 0)))
      (then
        (if (i32.ne (i32.and (local.get $format) (i32.const 0x400)) (i32.const 0))
          (then
            (local.set $calculated_right (i32.load offset=8 (local.get $rect)))
            (i32.store (local.get $rect) (local.get $left))
            (i32.store offset=4 (local.get $rect) (local.get $top))
            (i32.store offset=8 (local.get $rect)
              (i32.add (local.get $calculated_right) (local.get $right_margin))))
          (else
            (i32.store (local.get $rect) (local.get $left))
            (i32.store offset=4 (local.get $rect) (local.get $top))
            (i32.store offset=8 (local.get $rect) (local.get $right))
            (i32.store offset=12 (local.get $rect) (local.get $bottom))))))
    (local.get $result))

  ;; DrawTextExA(hdc, lpString, nCount, lpRect, uFormat, lpDTParams)
  (func $handle_DrawTextExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $draw_text_ex
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; DrawEdge(hdc, qrc, edge, grfFlags) — 4 args stdcall
  (func $handle_DrawEdge (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rc i32) (local $desc i32)
    (local.set $rc (call $g2w (local.get $arg1)))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_draw_edge_desc
        (local.get $arg0) (local.get $desc)
        (i32.load (local.get $rc)) (i32.load offset=4 (local.get $rc))
        (i32.load offset=8 (local.get $rc)) (i32.load offset=12 (local.get $rc))
        (local.get $arg2) (local.get $arg3) (local.get $rc))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 144: GetClipboardData(uFormat) → HANDLE
  ;; CF_TEXT/CF_OEMTEXT plus registered non-OLE Rich Text Format clipboard
  ;; data. Handles are direct heap pointers, matching the emulator's GlobalLock
  ;; identity behavior.
  (func $handle_GetClipboardData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (call $clipboard_get_data_handle (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
  ;; ShellAbout's strings come straight from the guest call. No PE
  ;; version-resource parsing needed; WAT can build the dialog entirely
  ;; from the args. The host_shell_about import only logs (so the
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
    (call $modal_capture_nonvolatile)
    (global.set $opendlg_wide (i32.const 0))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    ;; OPENFILENAME.hwndOwner at +4
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_open_dialog (local.get $dlg) (local.get $owner) (i32.const 0) (local.get $arg0))
    ;; 1-arg stdcall: ret addr (4) + arg (4) = 8 bytes to pop on return.
    (call $modal_begin (local.get $dlg) (i32.const 8))
  )

  ;; GetOpenFileNameW(lpOFN) — the dialog UI uses the same byte-oriented WAT
  ;; controls, while filter parsing and the selected output buffer honor the
  ;; Unicode OPENFILENAME contract.
  (func $handle_GetOpenFileNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (call $modal_capture_nonvolatile)
    (global.set $opendlg_wide (i32.const 1))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_open_dialog (local.get $dlg) (local.get $owner) (i32.const 0) (local.get $arg0))
    (call $modal_begin (local.get $dlg) (i32.const 8))
  )

  ;; 200: GetFileTitleA(lpszFile, lpszTitle, cbBuf)
  ;; Return the display title portion of a path. Success returns 0; if the
  ;; destination buffer is too small, return the required char count including
  ;; the NUL terminator. Good enough for Notepad's File->Open title update.
  (func $handle_GetFileTitleA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $base i32) (local $ch i32) (local $len i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $p (local.get $arg0))
    (local.set $base (local.get $arg0))
    (block $done (loop $scan
      (local.set $ch (call $gl8 (local.get $p)))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.or
            (i32.or (i32.eq (local.get $ch) (i32.const 0x5C)) ;; '\'
                    (i32.eq (local.get $ch) (i32.const 0x2F))) ;; '/'
            (i32.eq (local.get $ch) (i32.const 0x3A)))         ;; ':'
        (then (local.set $base (i32.add (local.get $p) (i32.const 1)))))
      (local.set $p (i32.add (local.get $p) (i32.const 1)))
      (br $scan)))
    (local.set $len (call $guest_strlen (local.get $base)))
    (if (i32.or (i32.eqz (local.get $arg1))
                (i32.lt_u (local.get $arg2) (i32.add (local.get $len) (i32.const 1))))
      (then
        (global.set $eax (i32.add (local.get $len) (i32.const 1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (call $guest_strcpy (local.get $arg1) (local.get $base))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 201: ChooseFontA(lpCF) — show the WAT-driven Font picker with face/
  ;; style/size listboxes. On OK, writes chosen size back to LOGFONT.lfHeight.
  (func $handle_ChooseFontA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (call $modal_capture_nonvolatile)
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
    (call $create_findreplace_dialog (local.get $hwnd) (local.get $owner) (local.get $arg0) (i32.const 0))
    (global.set $eax (local.get $hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; ReplaceTextA(lpFR) — create modeless Replace dialog, return HWND.
  ;; This is commonly resolved dynamically by MFC, so it must participate in
  ;; the normal API hash/GetProcAddress path even when no PE imports it.
  (func $handle_ReplaceTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32) (local $owner i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_findreplace_dialog (local.get $hwnd) (local.get $owner) (local.get $arg0) (i32.const 1))
    (global.set $eax (local.get $hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 203: PageSetupDlgA(lpPS) — show placeholder modal dialog
  (func $handle_PageSetupDlgA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32) (local $flags i32)
    (call $modal_capture_nonvolatile)
    (local.set $flags (call $gl32 (i32.add (local.get $arg0) (i32.const 16))))
    ;; PAGESETUPDLG ptPaperSize + rtMinMargin + rtMargin. WordPad requests
    ;; thousandths of an inch; also honor hundredths-of-mm callers.
    (if (i32.and (local.get $flags) (i32.const 8)) ;; PSD_INHUNDREDTHSOFMILLIMETERS
      (then
        (call $gs32 (i32.add (local.get $arg0) (i32.const 20)) (i32.const 21590))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 24)) (i32.const 27940))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 28)) (i32.const 635))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 32)) (i32.const 635))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 36)) (i32.const 635))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 40)) (i32.const 635))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 44)) (i32.const 2540))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 48)) (i32.const 2540))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 52)) (i32.const 2540))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 56)) (i32.const 2540)))
      (else
        (call $gs32 (i32.add (local.get $arg0) (i32.const 20)) (i32.const 8500))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 24)) (i32.const 11000))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 28)) (i32.const 250))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 32)) (i32.const 250))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 36)) (i32.const 250))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 40)) (i32.const 250))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 44)) (i32.const 1000))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 48)) (i32.const 1000))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 52)) (i32.const 1000))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 56)) (i32.const 1000))))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (global.set $common_dialog_kind (i32.const 1))
    (global.set $common_dialog_struct (local.get $arg0))
    (call $create_page_setup_dialog (local.get $dlg) (local.get $owner))
    (call $modal_begin (local.get $dlg) (i32.const 8)))

  ;; 204: CommDlgExtendedError() — return 0 (no error)
  (func $handle_CommDlgExtendedError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; 205: exit
  (func $handle_exit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (call $host_exit (local.get $arg0))
    (global.set $eip (i32.const 0))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0)) (return)
  )

  ;; 206: _exit
  (func $handle__exit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (call $host_exit (local.get $arg0))
    (global.set $eip (i32.const 0))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0)) (return)
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
    ;; cdecl: pop only the return address; the caller owns both arguments.
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; 211: _controlfp(new, mask) — cdecl; return default FPU control word
  (func $handle__controlfp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x9001F))
    ;; The caller owns the two arguments. Pop only our return address.
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; 216: _XcptFilter — cdecl, returns EXCEPTION_CONTINUE_SEARCH (0).
  ;; nop was leaving ret-addr on stack and corrupting subsequent instructions;
  ;; pop the ret-addr (cdecl: caller pops args).
  (func $handle__XcptFilter (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 217: _CxxThrowException — STUB: unimplemented
  (func $handle__CxxThrowException (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 218-222, 250: the lstr* family. These used to call $dispatch_lstr, which
  ;; re-read the API *name* one character at a time to decide which of them it
  ;; was — after the generated br_table had already resolved that name to this
  ;; exact function. The name-sniffing layer is gone; each handler is its own
  ;; body, which is also what lets the Win16 bridge (09e) call them directly:
  ;; it has an ordinal, not a name, and so used to reimplement them instead.

  ;; The two spellings of each lstr* entry point differ only in character
  ;; width, so each operation has one body here with a $wide flag and both
  ;; handlers are thin spellings of it. They used to be written twice, and the
  ;; copies had drifted apart on NULL handling: lstrlenW and lstrcpyW checked
  ;; for NULL (which is what Win98 does — its lstr* sit behind an SEH handler
  ;; that turns a bad pointer into a benign result) while the ANSI twins
  ;; dereferenced it.

  (func $lstr_len (param $s i32) (param $wide i32) (result i32)
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (if (local.get $wide) (then (return (call $guest_wcslen (local.get $s)))))
    (call $guest_strlen (local.get $s)))

  (func $lstr_cpy (param $dst i32) (param $src i32) (param $wide i32)
    (if (i32.or (i32.eqz (local.get $dst)) (i32.eqz (local.get $src))) (then (return)))
    (if (local.get $wide)
      (then (call $guest_wcscpy (local.get $dst) (local.get $src)))
      (else (call $guest_strcpy (local.get $dst) (local.get $src)))))

  (func $lstr_cat (param $dst i32) (param $src i32) (param $wide i32)
    (if (i32.or (i32.eqz (local.get $dst)) (i32.eqz (local.get $src))) (then (return)))
    (call $lstr_cpy
      (i32.add (local.get $dst) (i32.mul (call $lstr_len (local.get $dst) (local.get $wide))
                                         (select (i32.const 2) (i32.const 1) (local.get $wide))))
      (local.get $src) (local.get $wide)))

  ;; Copies at most count-1 characters and always terminates.
  (func $lstr_cpyn (param $dst i32) (param $src i32) (param $max i32) (param $wide i32)
    (if (i32.or (i32.eqz (local.get $dst)) (i32.eqz (local.get $src))) (then (return)))
    (if (local.get $wide)
      (then (call $guest_wcsncpy (local.get $dst) (local.get $src) (local.get $max)))
      (else (call $guest_strncpy (local.get $dst) (local.get $src) (local.get $max)))))

  ;; Negative / zero / positive, optionally ASCII case-insensitive. A NULL
  ;; string sorts before a non-NULL one, and two NULLs are equal.
  (func $lstr_cmp (param $a i32) (param $b i32) (param $wide i32) (param $fold i32) (result i32)
    (local $i i32) (local $step i32) (local $c1 i32) (local $c2 i32)
    (if (i32.or (i32.eqz (local.get $a)) (i32.eqz (local.get $b)))
      (then (return (i32.sub (i32.ne (local.get $a) (i32.const 0))
                             (i32.ne (local.get $b) (i32.const 0))))))
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (block $done (loop $cmp
      (local.set $c1 (call $gl_char (i32.add (local.get $a) (local.get $i)) (local.get $wide)))
      (local.set $c2 (call $gl_char (i32.add (local.get $b) (local.get $i)) (local.get $wide)))
      (if (local.get $fold)
        (then
          (local.set $c1 (call $tolower (local.get $c1)))
          (local.set $c2 (call $tolower (local.get $c2)))))
      (if (i32.ne (local.get $c1) (local.get $c2))
        (then (return (i32.sub (local.get $c1) (local.get $c2)))))
      (br_if $done (i32.eqz (local.get $c1)))
      (local.set $i (i32.add (local.get $i) (local.get $step)))
      (br $cmp)))
    (i32.const 0))

  ;; One character at a guest address, ANSI or wide.
  (func $gl_char (param $p_g i32) (param $wide i32) (result i32)
    (if (local.get $wide) (then (return (call $gl16 (local.get $p_g)))))
    (call $gl8 (local.get $p_g)))

  ;; 218: lstrlenA
  (func $handle_lstrlenA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $lstr_len (local.get $arg0) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 219: lstrcpyA
  (func $handle_lstrcpyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $lstr_cpy (local.get $arg0) (local.get $arg1) (i32.const 0))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 220: lstrcatA
  (func $handle_lstrcatA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $lstr_cat (local.get $arg0) (local.get $arg1) (i32.const 0))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 221: lstrcpynA(dst, src, count) — copies at most count-1 chars.
  (func $handle_lstrcpynA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $lstr_cpyn (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 222: lstrcmpA
  (func $handle_lstrcmpA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $lstr_cmp (local.get $arg0) (local.get $arg1) (i32.const 0) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 223: RegCloseKey(hKey) — 1 arg stdcall
  (func $handle_RegCloseKey (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_close_key (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; RegDeleteKeyA(hKey, lpSubKey) — 2 args stdcall
  (func $handle_RegDeleteKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_delete_key
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; RegDeleteKeyW(hKey, lpSubKey) — 2 args stdcall
  (func $handle_RegDeleteKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_delete_key
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; RegDeleteValueA(hKey, lpValueName) — 2 args stdcall
  (func $handle_RegDeleteValueA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_delete_value
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; RegDeleteValueW(hKey, lpValueName) — 2 args stdcall
  (func $handle_RegDeleteValueW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_delete_value
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; SHQueryValueExA/W(hKey, pszValue, pdwReserved, pdwType, pvData, pcbData)
  ;; SHLWAPI's registry read. It differs from RegQueryValueEx only in that it
  ;; expands a REG_EXPAND_SZ result and reports it as REG_SZ; the registry
  ;; here stores no unexpanded strings, so the read is the same read.
  ;; Explorer reaches this through SHELL32 ordinal 509.
  (func $handle_SHQueryValueExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_query_value
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg3)
      (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  (func $handle_SHQueryValueExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_query_value
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg3)
      (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (i32.const 1)))
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

  ;; 227-231: the Local* family, formerly routed through $dispatch_local, which
  ;; picked the operation from name[5]. Local and Global memory are the same
  ;; heap here, so the pairs are deliberately identical bodies.

  ;; 227: LocalAlloc(uFlags, uBytes)
  (func $handle_LocalAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_alloc (local.get $arg1)))
    (if (i32.and (local.get $arg0) (i32.const 0x40)) ;; LMEM_ZEROINIT
      (then (if (global.get $eax)
              (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $arg1))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 228: LocalFree
  (func $handle_LocalFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $heap_free (local.get $arg0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 229: LocalLock — handles are pointers here, so locking is the identity.
  (func $handle_LocalLock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 230: LocalUnlock — returns FALSE, meaning the lock count reached zero.
  (func $handle_LocalUnlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 231: LocalReAlloc(hMem, uBytes, uFlags)
  (func $handle_LocalReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_realloc (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; LocalSize(hMem) — LocalAlloc returns a fixed guest pointer whose aligned
  ;; allocation size is stored in the four-byte heap header immediately before
  ;; it. Return the usable data bytes, matching the existing GlobalSize path.
  (func $handle_LocalSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0)))
      (else
        (global.set $eax
          (i32.sub (call $gl32 (i32.sub (local.get $arg0) (i32.const 4)))
                   (i32.const 4)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 232-237: the Global* family, formerly routed through $dispatch_global,
  ;; which picked the operation from name[6]. That byte aliased
  ;; GlobalAddAtomA with GlobalAlloc and GlobalFindAtomA/GlobalFlags with
  ;; GlobalFree — safe only because those happened to have their own handlers.

  ;; 232: GlobalAlloc(uFlags, dwBytes)
  (func $handle_GlobalAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_alloc (local.get $arg1)))
    (if (i32.and (local.get $arg0) (i32.const 0x40)) ;; GMEM_ZEROINIT
      (then (if (global.get $eax)
              (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $arg1))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 233: GlobalFree
  (func $handle_GlobalFree (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $heap_free (local.get $arg0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 234: GlobalLock
  (func $handle_GlobalLock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 235: GlobalUnlock
  (func $handle_GlobalUnlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 236: GlobalReAlloc(hMem, dwBytes, uFlags)
  (func $handle_GlobalReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $heap_realloc (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 237: GlobalSize — usable bytes, from the four-byte heap header before the
  ;; block. Same rule as $handle_LocalSize.
  (func $handle_GlobalSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (i32.sub (call $gl32 (i32.sub (local.get $arg0) (i32.const 4))) (i32.const 4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 32)))))
    (else
      (if (i32.and
            (i32.and (i32.eqz (global.get $wndproc_addr2))
                     (i32.ne (local.get $tmp) (global.get $wndproc_addr)))
            (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
                     (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
        (then (global.set $wndproc_addr2 (local.get $tmp))))))
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
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 28)))))
    (else
      (if (i32.and
            (i32.and (i32.eqz (global.get $wndproc_addr2))
                     (i32.ne (local.get $tmp) (global.get $wndproc_addr)))
            (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
                     (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
        (then (global.set $wndproc_addr2 (local.get $tmp))))))
    (global.set $eax (i32.const 0xC001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 243: BeginPaint
  (func $handle_BeginPaint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32) (local $brush i32) (local $hdc i32) (local $wa i32) (local $partial i32) (local $desc i32)
    ;; Win98: BeginPaint sends WM_ERASEBKGND before returning. The default
    ;; handler fills the client area with this hwnd's registered class
    ;; hbrBackground. A NULL hbrBackground means no default erase; the app owns
    ;; the pixels. Do not use the last-registered class here: Solitaire's
    ;; custom "Stat" child is created after the main class and must not change
    ;; how unrelated hwnds erase.
    (local.set $brush (call $wnd_get_bg_brush (local.get $arg0)))
    ;; Fill PAINTSTRUCT: hdc(+0), fErase(+4), rcPaint(+8: left,top,right,bottom)
    (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 64))
    (local.set $hdc (call $host_alloc_window_dc (local.get $arg0) (i32.const 0)))
    (call $gs32 (local.get $arg1) (local.get $hdc)) ;; hdc
    (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0)) ;; fErase
    ;; WAT owns the update rect. rcPaint is the pending update bbox; if no
    ;; update exists, return the full client rect like Win32's empty fallback.
    (local.set $wa (i32.add (call $g2w (local.get $arg1)) (i32.const 8)))
    (local.set $partial (call $update_get_rect (local.get $arg0) (local.get $wa)))
	    (if (i32.eqz (local.get $partial))
	      (then
	        ;; Empty update rect: rcPaint = full client.
	        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
	        (i32.store offset=8  (call $g2w (local.get $arg1)) (i32.const 0))
	        (i32.store offset=12 (call $g2w (local.get $arg1)) (i32.const 0))
	        (i32.store offset=16 (call $g2w (local.get $arg1)) (i32.and (local.get $cs) (i32.const 0xFFFF)))
	        (i32.store offset=20 (call $g2w (local.get $arg1)) (i32.shr_u (local.get $cs) (i32.const 16)))))
	    ;; Some Win9x games resize/maximize from inside WM_PAINT and then draw a
	    ;; complete redraw-class scene while the old partial update region is still
	    ;; installed. For maximized CS_HREDRAW/CS_VREDRAW top-levels, promote that
	    ;; paint to the full client so the redraw is not clipped to the pre-resize
	    ;; splash/update rectangle.
	    (if (i32.and
	          (i32.and (local.get $partial) (call $wnd_max_get (local.get $arg0)))
	          (i32.ne (i32.and (global.get $wndclass_style) (i32.const 0x0003)) (i32.const 0)))
	      (then
	        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
	        (i32.store offset=8  (call $g2w (local.get $arg1)) (i32.const 0))
	        (i32.store offset=12 (call $g2w (local.get $arg1)) (i32.const 0))
	        (i32.store offset=16 (call $g2w (local.get $arg1)) (i32.and (local.get $cs) (i32.const 0xFFFF)))
	        (i32.store offset=20 (call $g2w (local.get $arg1)) (i32.shr_u (local.get $cs) (i32.const 16)))
	        (local.set $partial (i32.const 0))))
	    ;; WAT-owned visible clipping: update rect, client bounds, parent,
    ;; CLIPCHILDREN and CLIPSIBLINGS all compose into the HDC clip.
    (if (local.get $partial)
      (then
        (drop (call $host_gdi_intersect_clip_rect
          (local.get $hdc)
          (i32.load (local.get $wa))
          (i32.load offset=4 (local.get $wa))
          (i32.load offset=8 (local.get $wa))
          (i32.load offset=12 (local.get $wa))))))
    (call $dc_apply_client_clip (local.get $hdc) (local.get $arg0))
    ;; Erase through the same clipped paint HDC. Win98's BeginPaint/WM_ERASEBKGND
    ;; is constrained by the update/visible region; erasing before the clip is
    ;; installed wipes too much during small invalidations (Spider card drags).
    (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
    ;; Whose background is it? Filling here unconditionally is right for a
    ;; window that lets USER paint its background, and destroys one that paints
    ;; its own: Hearts fills its baize green in WM_ERASEBKGND and was registered
    ;; with WHITE_BRUSH, so every paint turned the table white -- and which of
    ;; the two won depended on the order the pump happened to run them in, so it
    ;; flickered between green and white as the game went on.
    ;;
    ;; The window itself has already answered the question. NC_FLAGS bit 3 is
    ;; set when a WM_ERASEBKGND reaches DefWindowProc, which only happens for a
    ;; window that did not want it. Bit 1 means an erase is still outstanding
    ;; and nobody has been given it yet -- the first paint of a window's life --
    ;; and the class brush is the right answer there too.
    ;;
    ;; Children keep the old unconditional fill. An erase is only ever queued
    ;; for a window once, at creation, so for anything that repaints often this
    ;; is the only background it gets; Hearts' own status bar draws its text
    ;; straight over whatever is there and its lines piled up on each other the
    ;; moment the fill stopped. The bug being fixed here is a top-level one --
    ;; a game that paints its table and was registered with WHITE_BRUSH -- so
    ;; that is where the behaviour changes.
    (if (i32.and (local.get $brush)
          (i32.or
            (i32.ne (i32.and (call $wnd_get_style (local.get $arg0))
                             (i32.const 0x40000000)) (i32.const 0))
            (i32.ne (i32.and (call $nc_flags_test (local.get $arg0))
                             (i32.const 10)) (i32.const 0))))
      (then
        (call $nc_flags_clear (local.get $arg0) (i32.const 2))
        (local.set $desc (global.get $GDI_LINE_DESC))
        (if (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc))
          (then (drop (call $gdi_fill_rect_desc
            (local.get $hdc) (local.get $desc)
            (i32.const 0) (i32.const 0)
            (i32.and (local.get $cs) (i32.const 0xFFFF))
            (i32.shr_u (local.get $cs) (i32.const 16))
            (local.get $brush)))))))
    (global.set $eax (local.get $hdc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 244: OpenClipboard(hwndNewOwner) — single-process clipboard, always open.
  (func $handle_OpenClipboard (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg0))
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 245: CloseClipboard() — single-process clipboard, always succeeds.
  (func $handle_CloseClipboard (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg0))
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 246: IsClipboardFormatAvailable(format)
  (func $handle_IsClipboardFormatAvailable (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (call $clipboard_is_format_available (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 247: GetEnvironmentStringsW — a wide copy of the process environment.
  ;; This used to answer with a literal L"A=B\0\0" while the ANSI spelling
  ;; handed back the command line, so the two disagreed about the environment
  ;; and neither described it. Both are copies of one real block now.
  (func $handle_GetEnvironmentStringsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $env_strings (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 248: GetSaveFileNameA(lpOFN) — show modal Save As dialog
  ;; Same UI as GetOpenFileName, just kind=1 → "Save As" title + "Save" button.
  (func $handle_GetSaveFileNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (call $modal_capture_nonvolatile)
    (global.set $opendlg_wide (i32.const 0))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_open_dialog (local.get $dlg) (local.get $owner) (i32.const 1) (local.get $arg0))
    (call $modal_begin (local.get $dlg) (i32.const 8))
  )

  ;; GetSaveFileNameW(lpOFN) — the W twin of the above, exactly as
  ;; GetOpenFileNameW is to GetOpenFileNameA. It was simply missing, so
  ;; the XP Sound Recorder (a Unicode app) trapped on File > Save and
  ;; File > Save As instead of showing a dialog.
  (func $handle_GetSaveFileNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32)
    (call $modal_capture_nonvolatile)
    (global.set $opendlg_wide (i32.const 1))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_open_dialog (local.get $dlg) (local.get $owner) (i32.const 1) (local.get $arg0))
    (call $modal_begin (local.get $dlg) (i32.const 8))
  )

;; 250: lstrcmpiA
  (func $handle_lstrcmpiA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $lstr_cmp (local.get $arg0) (local.get $arg1) (i32.const 0) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 251-252: FreeEnvironmentStrings{A,W} — release the copy handed out by
  ;; GetEnvironmentStrings. Both spellings free the same kind of heap block.
  (func $handle_FreeEnvironmentStringsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0) (then (call $heap_free (local.get $arg0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_FreeEnvironmentStringsW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_FreeEnvironmentStringsA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 253: GetVersion — return winver, 0 args
  (func $handle_GetVersion (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $winver))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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
    ;; wsprintf_impl expects arg_ptr as a guest address and reads args with gl32.
    (global.set $eax (call $wsprintf_impl
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
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
      (then (call $store_fake_wcmdline)))
    (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 776)))
    (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 784)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 258: __p__wcmdln
  (func $handle___p__wcmdln (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
      (then (call $store_fake_wcmdline)))
    (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 768)) (global.get $msvcrt_wcmdln_ptr))
    (global.set $eax (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 768)))
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

  ;; 260: __set_app_type(type) — cdecl; sets GUI vs console, no-op for us
  (func $handle___set_app_type (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 261: __setusermatherr(handler) — cdecl; set math error handler, no-op
  (func $handle___setusermatherr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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

  ;; operator new(size_t) / operator new[](size_t) — cdecl. The MSVC decorated
  ;; names ??2@YAPAXI@Z and ??_U@YAPAXI@Z; both are plain allocations, and
  ;; MSVC's own implementations are malloc with a new-handler retry loop we
  ;; have no use for. Returning NULL on exhaustion matches the non-throwing
  ;; behaviour of the msvcrt these binaries link against.
  (func $cpp_operator_new (param $size i32)
    (global.set $eax (call $heap_alloc (local.get $size)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )
  (func $handle_??2@YAPAXI@Z (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $cpp_operator_new (local.get $arg0))
  )
  (func $handle_??_U@YAPAXI@Z (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $cpp_operator_new (local.get $arg0))
  )

  ;; operator delete(void*) / operator delete[](void*) — cdecl, and a NULL
  ;; pointer is explicitly a no-op in C++.
  (func $cpp_operator_delete (param $ptr i32)
    (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )
  (func $handle_??3@YAXPAX@Z (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $cpp_operator_delete (local.get $arg0))
  )
  (func $handle_??_V@YAXPAX@Z (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $cpp_operator_delete (local.get $arg0))
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

  ;; 269: _onexit(func) — cdecl; accept the shutdown registration.
  ;; The emulator tears down the whole guest process at exit, so there is no
  ;; process-global CRT state left for these callbacks to release. Returning
  ;; the supplied function matches successful CRT registration.
  (func $handle__onexit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 270: __dllonexit(func, begin, end) — cdecl; DLL-local counterpart.
  (func $handle___dllonexit (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 271: _splitpath — STUB: unimplemented
  (func $handle__splitpath (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 272: _wcsicmp — STUB: unimplemented
  (func $handle__wcsicmp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 273: _wtoi — cdecl; wide string to int
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
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 274: _itow — int to wide string (STUB: unimplemented: write "0")
  (func $handle__itow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $crt_itoa (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
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
      (then
        (memory.fill (call $g2w (local.get $arg0)) (local.get $arg1) (local.get $arg2))))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 279: memcpy(dest, src, count) — cdecl
  (func $handle_memcpy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2)
      (then
        (memory.copy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))))
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

  ;; 283: GetModuleHandleW(lpModuleName) — the A lookup, over a narrowed name.
  ;; It used to run its own search ($find_dll_by_wname, now gone) that compared
  ;; the name exactly and knew nothing of the ole32 rule, so the same module
  ;; resolved under one spelling and came back NULL under the other.
  (func $handle_GetModuleHandleW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $len i32) (local $ansi i32)
    (if (local.get $arg0)
      (then
        (local.set $len (i32.add (call $guest_wcslen (local.get $arg0)) (i32.const 1)))
        (local.set $ansi (call $heap_alloc (local.get $len)))
        (if (i32.eqz (local.get $ansi))
          (then (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
                (return)))
        (drop (call $wide_to_ansi (local.get $arg0) (local.get $ansi) (local.get $len)))))
    (call $handle_GetModuleHandleA (local.get $ansi) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
    (if (local.get $ansi) (then (call $heap_free (local.get $ansi))))
  )

  ;; 284: GetModuleFileNameW — write L"C:\<exe_name>\0" as wide string
  (func $handle_GetModuleFileNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $module_file_name (local.get $arg1) (local.get $arg2) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 285: GetCommandLineW
  (func $handle_GetCommandLineW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
      (then (call $store_fake_wcmdline)))
    (global.set $eax (global.get $msvcrt_wcmdln_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 286: CreateWindowExW — convert ASCII-compatible wide strings and reuse
  ;; the mature A path. This keeps Unicode callers on the same CBT hook,
  ;; WM_CREATE, menu, owner/parent, control-class, and show/paint machinery as
  ;; ANSI callers. Class table keys are byte-string hashes, so RegisterClassW
  ;; and CreateWindowExA-style lookup share the same slots after conversion.
  (func $handle_CreateWindowExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $class_a i32) (local $title_a i32) (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (local.set $class_a (local.get $arg1))
    (if (i32.ge_u (local.get $arg1) (i32.const 0x10000))
      (then
        (local.set $class_a (call $heap_alloc (i32.const 256)))
        (if (local.get $class_a)
          (then
            (drop (call $wide_to_ansi (local.get $arg1) (local.get $class_a) (i32.const 256)))))))
    (local.set $title_a (local.get $arg2))
    (if (i32.ge_u (local.get $arg2) (i32.const 0x10000))
      (then
        (local.set $title_a (call $heap_alloc (i32.const 512)))
        (if (local.get $title_a)
          (then
            (drop (call $wide_to_ansi (local.get $arg2) (local.get $title_a) (i32.const 512)))))))
    (call $handle_CreateWindowExA
      (local.get $arg0)
      (local.get $class_a)
      (local.get $title_a)
      (local.get $arg3)
      (local.get $arg4)
      (local.get $name_ptr))
    (call $wnd_unicode_set (local.get $hwnd) (i32.const 1))
    (return)
  )

  ;; 287: RegisterClassW
  (func $handle_RegisterClassW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; RegisterClassW — same layout as RegisterClassA, just Unicode strings
    (local $tmp i32) (local $class_name_wa i32) (local $slot i32) (local $dst i32)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (local.set $class_name_wa (call $class_wide_name_key (call $gl32 (i32.add (local.get $arg0) (i32.const 36)))))
    (global.set $eax (call $class_table_register (local.get $class_name_wa)))
    (local.set $slot (call $class_find_slot (local.get $class_name_wa)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $dst (call $class_wndclass_addr (local.get $slot)))
        (call $memcpy (local.get $dst) (call $g2w (local.get $arg0)) (i32.const 40))))
    (if (i32.and (i32.eqz (global.get $wndproc_addr))
      (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
               (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (local.get $arg0)))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 28)))))
    (else (if (i32.and
      (i32.and (i32.eqz (global.get $wndproc_addr2))
               (i32.ne (local.get $tmp) (global.get $wndproc_addr)))
      (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
               (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
    (then (global.set $wndproc_addr2 (local.get $tmp))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 288: RegisterClassExW
  (func $handle_RegisterClassExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $class_name_wa i32) (local $slot i32) (local $dst i32) (local $src i32)
    ;; WNDCLASSEXW: cbSize(+0) style(+4) lpfnWndProc(+8) ... lpszClassName(+40)
    (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 8))))
    (local.set $class_name_wa (call $class_wide_name_key (call $gl32 (i32.add (local.get $arg0) (i32.const 40)))))
    (global.set $eax (call $class_table_register (local.get $class_name_wa)))
    (local.set $slot (call $class_find_slot (local.get $class_name_wa)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $dst (call $class_wndclass_addr (local.get $slot)))
        (local.set $src (call $g2w (i32.add (local.get $arg0) (i32.const 4))))
        (call $memcpy (local.get $dst) (local.get $src) (i32.const 36))
        (i32.store (i32.add (local.get $dst) (i32.const 36))
          (call $gl32 (i32.add (local.get $arg0) (i32.const 40))))))
    (if (i32.and (i32.eqz (global.get $wndproc_addr))
      (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
               (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
    (then
      (global.set $wndproc_addr (local.get $tmp))
      (global.set $wndclass_style (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
      (global.set $wndclass_bg_brush (call $gl32 (i32.add (local.get $arg0) (i32.const 32)))))
    (else
      (if (i32.and
            (i32.and (i32.eqz (global.get $wndproc_addr2))
                     (i32.ne (local.get $tmp) (global.get $wndproc_addr)))
            (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
                     (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (global.get $exe_size_of_image)))))
        (then (global.set $wndproc_addr2 (local.get $tmp))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 289: DefWindowProcW — same as DefWindowProcA
  (func $handle_DefWindowProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; WM_CLOSE (0x10): default close destroys the target. Only closing the
    ;; main window should end the message loop; modeless dialogs are ordinary
    ;; owned windows and closing them must not terminate the app.
    (if (i32.eq (local.get $arg1) (i32.const 0x0010))
    (then
      ;; A DialogBoxParamA dialog closed through default WM_CLOSE must end
      ;; the modal pump; destroying the HWND alone leaves the guest waiting
      ;; forever in the CACA0004 loop.
      (if (i32.and
            (i32.ne (global.get $dlg_pump_hwnd) (i32.const 0))
            (i32.eq (local.get $arg0) (global.get $dlg_pump_hwnd)))
        (then
          (global.set $dlg_ended (i32.const 1))
          (global.set $dlg_result (i32.const 2)) ;; IDCANCEL
          (i32.store (global.get $SHARED_DLG_ENDED) (i32.const 1))
          (i32.store (global.get $SHARED_DLG_RESULT) (i32.const 2))
          (if (call $wnd_table_get (local.get $arg0))
            (then
              (call $wnd_destroy_children (local.get $arg0))
              (call $wnd_table_remove (local.get $arg0))))
          (call $host_destroy_window (local.get $arg0))
          (global.set $yield_flag (i32.const 1))
          (global.set $eax (i32.const 0))
          (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
          (return)))
      (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
        (then (global.set $quit_flag (i32.const 1))))
      (if (i32.eq (local.get $arg0) (global.get $focus_hwnd))
        (then (global.set $focus_hwnd (i32.const 0))))
      (call $wnd_destroy_recursive (local.get $arg0))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; WM_ERASEBKGND (0x14): fill client area with background brush
    (if (i32.eq (local.get $arg1) (i32.const 0x0014))
    (then
    ;; Reaching here is the window saying that USER owns its background: it was
    ;; sent the erase and handed it straight back. NC_FLAGS bit 3 records that,
    ;; and $handle_BeginPaint uses it to decide whether to repaint the class
    ;; brush on later paints. A window that erases for itself never gets here,
    ;; and must not have its own background overwritten -- Hearts fills its
    ;; baize green and was registered with WHITE_BRUSH.
    (call $nc_flags_set (local.get $arg0) (i32.const 8))
    (global.set $eax (call $host_erase_background (local.get $arg0) (call $wnd_get_bg_brush (local.get $arg0))))
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
      (else
        (if (i32.lt_u (local.get $arg1) (i32.const 0x10000))
          (then (global.set $eax (i32.or (i32.const 0x680000)
                                         (i32.and (local.get $arg1) (i32.const 0xFFFF)))))
          (else (global.set $eax (i32.const 0x67F00))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 291: LoadIconW(hInstance, lpIconName) → HICON. An icon named by ordinal —
  ;; MAKEINTRESOURCE, which is every icon we can actually decode — has no
  ;; encoding, so this is the A implementation verbatim: it used to hand back
  ;; the opaque no-pixels handle and the same icon drew in A and vanished in W.
  (func $handle_LoadIconW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_LoadIconA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

;; 293: MessageBoxW — build the same modal UI as MessageBoxA
  (func $handle_MessageBoxW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $text_gp i32) (local $cap_gp i32) (local $text_wa i32) (local $cap_wa i32)
    (call $modal_capture_nonvolatile)
    (if (i32.ge_u (local.get $arg1) (i32.const 0x10000))
      (then
        (local.set $text_gp (call $heap_alloc
          (i32.add (call $guest_wcslen (local.get $arg1)) (i32.const 1))))
        (if (local.get $text_gp)
          (then
            (drop (call $wide_to_ansi
              (local.get $arg1)
              (local.get $text_gp)
              (i32.add (call $guest_wcslen (local.get $arg1)) (i32.const 1))))
            (local.set $text_wa (call $g2w (local.get $text_gp)))))))
    (if (i32.ge_u (local.get $arg2) (i32.const 0x10000))
      (then
        (local.set $cap_gp (call $heap_alloc
          (i32.add (call $guest_wcslen (local.get $arg2)) (i32.const 1))))
        (if (local.get $cap_gp)
          (then
            (drop (call $wide_to_ansi
              (local.get $arg2)
              (local.get $cap_gp)
              (i32.add (call $guest_wcslen (local.get $arg2)) (i32.const 1))))
            (local.set $cap_wa (call $g2w (local.get $cap_gp)))))))
    (drop (call $host_message_box
      (local.get $arg0) (local.get $text_wa) (local.get $cap_wa) (local.get $arg3)))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_msgbox_dialog
      (local.get $dlg) (local.get $arg0)
      (local.get $cap_wa) (local.get $text_wa)
      (local.get $arg3))
    (if (local.get $text_gp) (then (call $heap_free (local.get $text_gp))))
    (if (local.get $cap_gp) (then (call $heap_free (local.get $cap_gp))))
    (call $modal_begin (local.get $dlg) (i32.const 20))
  )

  ;; 294: SetWindowTextW(hwnd, lpString) → BOOL
  (func $handle_SetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $text_gp i32) (local $text_wa i32) (local $len i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (i32.ge_u (local.get $arg1) (i32.const 0x10000))
      (then
        (local.set $text_gp (call $heap_alloc
          (i32.add (call $guest_wcslen (local.get $arg1)) (i32.const 1))))
        (if (local.get $text_gp)
          (then
            (local.set $len (call $wide_to_ansi
              (local.get $arg1)
              (local.get $text_gp)
              (i32.add (call $guest_wcslen (local.get $arg1)) (i32.const 1))))
            (local.set $text_wa (call $g2w (local.get $text_gp)))))))
    ;; Child controls treat SetWindowText as WM_SETTEXT on their own wndproc.
    ;; WAT-native controls store byte strings, so pass the converted buffer.
    (if (i32.and
          (call $ctrl_table_get_class (local.get $arg0))
          (i32.or
            (i32.lt_u (call $ctrl_table_get_class (local.get $arg0)) (i32.const 10))
            (i32.gt_u (call $ctrl_table_get_class (local.get $arg0)) (i32.const 16))))
      (then
        (global.set $eax (call $control_wndproc_dispatch
          (local.get $arg0) (i32.const 0x000C) (i32.const 0) (local.get $text_gp)))
        (call $host_set_window_text (local.get $arg0) (local.get $text_wa))
        (if (local.get $text_gp) (then (call $heap_free (local.get $text_gp))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; Native child windows such as RichEdit20A are not WAT control-table
    ;; controls, but SetWindowText still maps to WM_SETTEXT for them.
    (if (i32.and
          (i32.ne (call $wnd_get_parent (local.get $arg0)) (i32.const 0))
          (i32.ne (call $wnd_table_get (local.get $arg0)) (i32.const 0)))
      (then
        (call $richedit_format_reset_hwnd (local.get $arg0))
        (call $title_table_set (local.get $arg0) (local.get $text_wa) (local.get $len))
        (global.set $eax (call $wnd_send_message
          (local.get $arg0) (i32.const 0x000C) (i32.const 0) (local.get $text_gp)))
        (call $host_set_window_text (local.get $arg0) (local.get $text_wa))
        (if (local.get $text_gp) (then (call $heap_free (local.get $text_gp))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (call $title_table_set (local.get $arg0) (local.get $text_wa) (local.get $len))
    (call $nc_flags_set (local.get $arg0) (i32.const 1))
    (call $defwndproc_do_ncpaint (local.get $arg0))
    (call $host_set_window_text (local.get $arg0) (local.get $text_wa))
    (if (local.get $text_gp) (then (call $heap_free (local.get $text_gp))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 295: GetWindowTextW(hwnd, lpString, nMaxCount) → int (chars copied)
  ;; The same read as GetWindowTextA, staged through an ANSI buffer of the
  ;; same character count and widened into the caller's. It used to answer
  ;; "" for every window, which is a wrong answer rather than a missing one.
  (func $handle_GetWindowTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $len i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $arg1)) (i32.le_s (local.get $arg2) (i32.const 0)))
      (then (global.set $eax (i32.const 0)) (return)))
    (i32.store16 (call $g2w (local.get $arg1)) (i32.const 0))
    (local.set $tmp (call $heap_alloc (local.get $arg2)))
    (if (i32.eqz (local.get $tmp))
      (then (global.set $eax (i32.const 0)) (return)))
    (call $gs8 (local.get $tmp) (i32.const 0))
    (local.set $len (call $window_text_ansi
      (local.get $arg0) (local.get $tmp) (local.get $arg2)))
    (drop (call $ansi_to_wide (local.get $tmp) (local.get $arg1) (local.get $arg2)))
    (call $heap_free (local.get $tmp))
    (global.set $eax (local.get $len)))

  ;; 296: SendMessageW — routing and stack layout are identical to A. Message
  ;; payloads remain opaque here; individual WAT controls interpret the
  ;; message-specific buffers. Reuse the synchronous subclass/default-proc
  ;; path so Unicode applications can drive common controls (Media Player 32
  ;; uses TB_ADDBUTTONSW through an app-installed toolbar subclass).
  ;; True for the messages whose lParam is a caller-supplied string. The W
  ;; forms carry UTF-16 there; WAT-native controls store bytes, so the text has
  ;; to be narrowed before it reaches one.
  (func $msg_lparam_is_text (param $msg i32) (result i32)
    (i32.or
      (i32.or
        (i32.eq (local.get $msg) (i32.const 0x000C))   ;; WM_SETTEXT
        (i32.eq (local.get $msg) (i32.const 0x00C2)))  ;; EM_REPLACESEL
      (i32.or
        (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0143))    ;; CB_ADDSTRING
                  (i32.eq (local.get $msg) (i32.const 0x014A)))   ;; CB_INSERTSTRING
          (i32.or (i32.eq (local.get $msg) (i32.const 0x014C))    ;; CB_FINDSTRING
                  (i32.eq (local.get $msg) (i32.const 0x014D))))  ;; CB_SELECTSTRING
        (i32.or
          (i32.or (i32.eq (local.get $msg) (i32.const 0x0158))    ;; CB_FINDSTRINGEXACT
                  (i32.eq (local.get $msg) (i32.const 0x0180)))   ;; LB_ADDSTRING
          (i32.or
            (i32.or (i32.eq (local.get $msg) (i32.const 0x0181))  ;; LB_INSERTSTRING
                    (i32.eq (local.get $msg) (i32.const 0x018C))) ;; LB_SELECTSTRING
            (i32.or (i32.eq (local.get $msg) (i32.const 0x018F))  ;; LB_FINDSTRING
                    (i32.eq (local.get $msg) (i32.const 0x01A2)))))))) ;; LB_FINDSTRINGEXACT

  ;; Narrow a W message's string lParam for a WAT-native target, or return 0
  ;; when nothing needs converting. Only WAT-native controls are converted: a
  ;; guest window that was sent a W message wants its UTF-16 pointer intact,
  ;; and for those SendMessage may redirect EIP and read the string long after
  ;; this returns, so a temporary buffer would be freed out from under it.
  (func $msg_narrow_text_lparam (param $hwnd i32) (param $msg i32) (param $lParam i32)
        (result i32)
    (local $n i32) (local $buf i32)
    (if (i32.eqz (call $msg_lparam_is_text (local.get $msg))) (then (return (i32.const 0))))
    (if (i32.lt_u (local.get $lParam) (i32.const 0x10000)) (then (return (i32.const 0))))
    (if (i32.eqz (call $ctrl_table_get_class (local.get $hwnd))) (then (return (i32.const 0))))
    (local.set $n (i32.add (call $guest_wcslen (local.get $lParam)) (i32.const 1)))
    (local.set $buf (call $heap_alloc (local.get $n)))
    (if (i32.eqz (local.get $buf)) (then (return (i32.const 0))))
    (drop (call $wide_to_ansi (local.get $lParam) (local.get $buf) (local.get $n)))
    (local.get $buf))

  ;; SendMessageW — the A path owns dispatch. Only the text-bearing messages
  ;; differ, and only when the target is one of our own controls: XP Sound
  ;; Recorder fills its format combo with CB_ADDSTRING of LoadStringW text, and
  ;; reading that UTF-16 as bytes left every row showing just its first letter.
  (func $handle_SendMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $narrow i32)
    (local.set $narrow
      (call $msg_narrow_text_lparam (local.get $arg0) (local.get $arg1) (local.get $arg3)))
    (call $handle_SendMessageA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (select (local.get $narrow) (local.get $arg3) (local.get $narrow))
      (local.get $arg4) (local.get $name_ptr))
    (if (local.get $narrow) (then (call $heap_free (local.get $narrow))))
  )

  ;; 297: PostMessageW — same as PostMessageA
  ;; A posted message carries no text, so the wide spelling is the ANSI one.
  ;; It used to be a copy of an older PostMessageA and had drifted: no
  ;; cross-instance routing, and it wrote the queue inline instead of going
  ;; through $post_queue_push, so Unicode callers were invisible to the
  ;; message tracing and could not post to another instance's window.
  (func $handle_PostMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_PostMessageA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  ;; 298: SetErrorMode — return 0, 1 arg stdcall
  (func $handle_SetErrorMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 299: GetCurrentThreadId — main thread is 1; worker threads get stable ids.
  (func $handle_GetCurrentThreadId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $current_thread_id))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 300: LoadLibraryW — convert the module name and use the same lookup/load
  ;; path as LoadLibraryA. TEXT_SCRATCH is WAT-private, so expose its inverse
  ;; g2w address while the synchronous host loader consumes the name.
  (func $handle_LoadLibraryW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ansi_gp i32)
    (local.set $ansi_gp
      (i32.add
        (i32.sub (global.get $TEXT_SCRATCH) (global.get $GUEST_BASE))
        (global.get $image_base)))
    (drop (call $wide_to_ansi
      (local.get $arg0) (local.get $ansi_gp) (global.get $TEXT_SCRATCH_SIZE)))
    (call $handle_LoadLibraryA
      (local.get $ansi_gp) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
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
    ;; Return the current high-bit down state without consuming
    ;; GetAsyncKeyState's one-shot press latch. Toggle-key low bits are not
    ;; tracked yet.
    (global.set $eax
      (i32.and
        (call $host_get_key_down_state (local.get $arg0))
        (i32.const 0x8000)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ToAsciiEx(uVirtKey, uScanCode, lpKeyState, lpChar, uFlags, hkl) → int.
  ;; 6-arg stdcall. Translate vkey + Shift state to up to one ASCII char in
  ;; *lpChar. Returns 1 on success, 0 if no translation, -1 for dead keys.
  ;; Minimal: handle letters/digits with Shift, and a handful of punctuation
  ;; that SDL apps rely on (Space, Enter, Esc, Tab).
  (func $handle_ToAsciiEx
    (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $vk i32) (local $ks i32) (local $out i32) (local $shift i32) (local $ch i32)
    (local.set $vk (local.get $arg0))
    (local.set $ks (call $g2w (local.get $arg2)))
    (local.set $out (call $g2w (local.get $arg3)))
    (local.set $shift (i32.and (i32.load8_u (i32.add (local.get $ks) (i32.const 0x10))) (i32.const 0x80)))
    (local.set $ch (i32.const 0))
    ;; A-Z (0x41-0x5A): lowercase unless Shift held
    (if (i32.and (i32.ge_u (local.get $vk) (i32.const 0x41)) (i32.le_u (local.get $vk) (i32.const 0x5A)))
      (then (local.set $ch
        (select (local.get $vk) (i32.add (local.get $vk) (i32.const 0x20)) (local.get $shift)))))
    ;; 0-9 (0x30-0x39): direct ASCII when no Shift; ignored with Shift here.
    (if (i32.eqz (local.get $ch))
      (then (if (i32.and (i32.ge_u (local.get $vk) (i32.const 0x30)) (i32.le_u (local.get $vk) (i32.const 0x39)))
        (then (if (i32.eqz (local.get $shift))
          (then (local.set $ch (local.get $vk))))))))
    ;; Space=0x20, Enter=0x0D, Esc=0x1B, Tab=0x09, Back=0x08
    (if (i32.eqz (local.get $ch))
      (then
        (if (i32.eq (local.get $vk) (i32.const 0x20)) (then (local.set $ch (i32.const 0x20))))
        (if (i32.eq (local.get $vk) (i32.const 0x0D)) (then (local.set $ch (i32.const 0x0D))))
        (if (i32.eq (local.get $vk) (i32.const 0x1B)) (then (local.set $ch (i32.const 0x1B))))
        (if (i32.eq (local.get $vk) (i32.const 0x09)) (then (local.set $ch (i32.const 0x09))))
        (if (i32.eq (local.get $vk) (i32.const 0x08)) (then (local.set $ch (i32.const 0x08))))))
    (if (local.get $ch)
      (then
        (i32.store16 (local.get $out) (local.get $ch))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; GetKeyboardState(LPBYTE lpKeyState[256]) → BOOL — 1 arg stdcall.
  ;; SDL polls this every frame to build its keyboard snapshot. Fill the 256-byte
  ;; buffer from $host_get_key_down_state so currently-held keys show up there
  ;; without consuming GetAsyncKeyState's one-shot low press bit.
  (func $handle_GetKeyboardState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $i i32) (local $w i32) (local $s i32)
    (local.set $w (call $g2w (local.get $arg0)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (i32.const 256)))
      (local.set $s (call $host_get_key_down_state (local.get $i)))
      ;; GetAsyncKeyState returns 0x8000 in high bit if down. Translate to
      ;; GetKeyboardState's high-bit-set byte (0x80) when down, else 0.
      (i32.store8 (i32.add (local.get $w) (local.get $i))
        (select (i32.const 0x80) (i32.const 0)
          (i32.and (local.get $s) (i32.const 0x8000))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 303: GetParent — STUB: unimplemented
  ;; GetParent(hwnd) — 1 arg stdcall, return parent hwnd or 0
  (func $handle_GetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wnd_get_parent_api (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 304: GetWindow(hWnd, uCmd) — 2 args stdcall.
  ;; Prefer WAT's per-instance window table, then fall back to the JS renderer's
  ;; full window list so cross-instance top-level/dialog relationships are still
  ;; visible to apps walking USER z-order.
  (func $handle_GetWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $parent i32) (local $known i32)
    (local.set $known
      (i32.ne (call $wnd_table_find (local.get $arg0)) (i32.const -1)))
    ;; GW_HWNDFIRST(0) / GW_HWNDLAST(1): first/last sibling at same parent.
    (if (i32.eq (local.get $arg1) (i32.const 0))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $arg0)))
        ;; The renderer owns the combined top-level z-order across app
        ;; instances. WAT remains authoritative for local child siblings.
        (global.set $eax
          (if (result i32) (i32.eqz (local.get $parent))
            (then (call $host_get_window_related (local.get $arg0) (local.get $arg1)))
            (else (call $wnd_find_first_child (local.get $parent)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (i32.eq (local.get $arg1) (i32.const 1))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $arg0)))
        (global.set $eax
          (if (result i32) (i32.eqz (local.get $parent))
            (then (call $host_get_window_related (local.get $arg0) (local.get $arg1)))
            (else (call $wnd_find_last_child (local.get $parent)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_HWNDNEXT = 2
    (if (i32.eq (local.get $arg1) (i32.const 2))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $arg0)))
        (global.set $eax
          (if (result i32) (i32.eqz (local.get $parent))
            (then (call $host_get_window_related (local.get $arg0) (local.get $arg1)))
            (else (call $wnd_find_next_sibling (local.get $arg0)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_HWNDPREV = 3
    (if (i32.eq (local.get $arg1) (i32.const 3))
      (then
        (local.set $parent (call $wnd_get_parent (local.get $arg0)))
        (global.set $eax
          (if (result i32) (i32.eqz (local.get $parent))
            (then (call $host_get_window_related (local.get $arg0) (local.get $arg1)))
            (else (call $wnd_find_prev_sibling (local.get $arg0)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_OWNER = 4 → return owner hwnd, not child geometry parent.
    (if (i32.eq (local.get $arg1) (i32.const 4))
      (then
        (global.set $eax (call $wnd_get_owner (local.get $arg0)))
        (if (i32.and (i32.eqz (global.get $eax)) (i32.eqz (local.get $known)))
          (then (global.set $eax (call $host_get_window_related (local.get $arg0) (local.get $arg1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_CHILD = 5 → first child of hwnd
    (if (i32.eq (local.get $arg1) (i32.const 5))
      (then
        (global.set $eax (call $wnd_find_first_child (local.get $arg0)))
        (if (i32.and (i32.eqz (global.get $eax)) (i32.eqz (local.get $known)))
          (then (global.set $eax (call $host_get_window_related (local.get $arg0) (local.get $arg1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; GW_ENABLEDPOPUP = 6 → enabled visible popup owned by hwnd, or hwnd itself.
    (if (i32.eq (local.get $arg1) (i32.const 6))
      (then
        (global.set $eax (call $host_get_window_related (local.get $arg0) (local.get $arg1)))
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

  ;; IsWindowUnicode(hwnd) reflects whether the HWND was created through a W
  ;; entry point. Native common controls use this to choose A/W message layouts.
  (func $handle_IsWindowUnicode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wnd_unicode_get (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; Describe a system control class to an app that asked about it.
  ;;
  ;; Neither VCL nor MFC creates a BUTTON window directly. They call
  ;; GetClassInfo on the system class, keep its lpfnWndProc, register their own
  ;; class name (TButton, Afx:...) with their own wndproc, and chain whatever
  ;; they do not handle back to the proc they kept. Painting is one of the
  ;; things they do not handle. Returning FALSE here sends VCL down its
  ;; DefWindowProc fallback, and the control is then painted by nobody.
  ;;
  ;; The wndproc handed out is a marker carrying the class id, because by the
  ;; time it is called back the window's own class name is the app's, not
  ;; USER's — the marker is the only remaining link to what it started as.
  ;; $name_key is the class key ($class_name_key for A, $class_wide_name_key
  ;; for W): an atom, or the WASM address of the name. $name_guest is what the
  ;; caller passed, and is echoed back as lpszClassName.
  (func $system_class_describe (param $name_key i32) (param $name_guest i32)
        (param $out_guest i32) (param $hinstance i32) (result i32)
    (local $class i32) (local $out i32)
    ;; Both spellings resolve here. An atom is a perfectly good lpClassName --
    ;; GetClassInfo(NULL, MAKEINTATOM(0x0080), &wc) succeeds on Windows -- so
    ;; declining the atom form, as this used to, told a dialog-driven app that
    ;; BUTTON does not exist.
    (local.set $class (call $builtin_ctrl_class_id_key (local.get $name_key)))
    (if (i32.eqz (local.get $class)) (then (return (i32.const 0))))
    (local.set $out (call $g2w (local.get $out_guest)))
    ;; CS_VREDRAW|CS_HREDRAW|CS_DBLCLKS|CS_GLOBALCLASS, as USER registers these.
    ;; VCL masks the DC bits off and forces CS_PARENTDC regardless of what it is
    ;; told. CS_GLOBALCLASS is what makes them visible to every process, which
    ;; is precisely the property an app is confirming when it asks.
    (i32.store (local.get $out) (i32.const 0x400B))
    (i32.store offset=4 (local.get $out)
      (i32.or (global.get $WNDPROC_SYSCLASS) (local.get $class)))
    (i32.store offset=8 (local.get $out) (i32.const 0))   ;; cbClsExtra
    (i32.store offset=12 (local.get $out) (i32.const 0))  ;; cbWndExtra
    (i32.store offset=16 (local.get $out) (local.get $hinstance))
    (i32.store offset=20 (local.get $out) (i32.const 0))  ;; hIcon
    (i32.store offset=24 (local.get $out) (i32.const 0))  ;; hCursor
    (i32.store offset=28 (local.get $out) (i32.const 0))  ;; hbrBackground
    (i32.store offset=32 (local.get $out) (i32.const 0))  ;; lpszMenuName
    (i32.store offset=36 (local.get $out) (local.get $name_guest))
    (i32.const 1))

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
    ;; Not one of the app's own classes — it may be one of USER's.
    (if (call $system_class_describe
          (call $class_name_key (local.get $arg1))
          (local.get $arg1) (local.get $arg2) (local.get $arg0))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; Not found — return FALSE
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 306: GetClassInfoW(hInstance, lpClassName, lpWndClass)
  (func $handle_GetClassInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $src i32) (local $key i32)
    (local.set $key (call $class_wide_name_key (local.get $arg1)))
    (local.set $slot (call $class_find_slot (local.get $key)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $src (call $class_wndclass_addr (local.get $slot)))
        (call $memcpy (call $g2w (local.get $arg2)) (local.get $src) (i32.const 40))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; USER's own classes answer the W entry point too. Before this, an app that
    ;; asked for L"BUTTON" was told no such class exists, which is the same
    ;; DefWindowProc fallback $system_class_describe was written to prevent --
    ;; it just could not be reached from here.
    (if (call $system_class_describe
          (local.get $key) (local.get $arg1) (local.get $arg2) (local.get $arg0))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
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

  ;; Set/GetClassLongW — same scalar indices as A; class string fields are not
  ;; modeled by the current lightweight class table.
  (func $handle_SetClassLongW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_SetClassLongA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  (func $handle_GetClassLongW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_GetClassLongA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
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

nW — STUB: unimplemented
  (func $handle_lstrlenW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $lstr_len (local.get $arg0) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 321: lstrcpyW
  (func $handle_lstrcpyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $lstr_cpy (local.get $arg0) (local.get $arg1) (i32.const 1))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 322: lstrcmpW(lpString1, lpString2) → int
  (func $handle_lstrcmpW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $lstr_cmp (local.get $arg0) (local.get $arg1) (i32.const 1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 323: lstrcmpiW(lpString1, lpString2) → int, ASCII case-insensitive
  (func $handle_lstrcmpiW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $lstr_cmp (local.get $arg0) (local.get $arg1) (i32.const 1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 324: CharNextW — advance by one wide char
  (func $handle_CharNextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.add (local.get $arg0) (i32.const 2)))
    (if (i32.eqz (call $gl16 (local.get $arg0)))
      (then (global.set $eax (local.get $arg0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; CharPrevW(lpszStart, lpszCurrent) — step back one UTF-16 code unit.
  (func $handle_CharPrevW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.le_u (local.get $arg1) (local.get $arg0))
      (then (global.set $eax (local.get $arg0)))
      (else (global.set $eax (i32.sub (local.get $arg1) (i32.const 2)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 325: wsprintfW — wide sprintf (cdecl, caller cleans up)
  ;; wsprintfW(buf, fmt, ...) — cdecl; varargs at guest esp+12 (after ret + buf + fmt)
  (func $handle_wsprintfW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; wsprintf_impl_w treats out/fmt/arg_ptr all as guest addresses (uses gl16/gl32 internally)
    (global.set $eax (call $wsprintf_impl_w
      (local.get $arg0)
      (local.get $arg1)
      (i32.add (global.get $esp) (i32.const 12))))
    ;; cdecl: only pop return address
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

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

  ;; 338: IsValidCodePage(CodePage)
  (func $handle_IsValidCodePage (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $is_supported_code_page (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 339: GetEnvironmentStringsA — an ANSI copy of the process environment.
  ;; It used to return the command line, which is a different string entirely
  ;; and has no double NUL, so a CRT walking it read past the end.
  (func $handle_GetEnvironmentStringsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $env_strings (i32.const 0)))
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

;; Is [ptr, ptr+len) unreadable? $g2w already knows the answer: it translates
  ;; every mapped guest region — the direct image window, DIB sections and the
  ;; sparse VirtualAlloc mappings — and returns $NULL_SENTINEL for anything it
  ;; cannot place. Asking it is the only test that stays true as the address
  ;; space grows.
  ;;
  ;; The previous test was a flat "above 0x02000000 is bad", which stopped being
  ;; true long ago: the sparse heap and VirtualAlloc arena live up near
  ;; 0x3F800000, and an app's own stack sits well above the cutoff too (the
  ;; Direct3D viewer runs on one at 0x074FFxxx). A caller handing us a stack
  ;; buffer — the ordinary way to use this API — was told its own frame was
  ;; unreadable.
  (func $ptr_range_bad (param $ptr i32) (param $len i32) (result i32)
    (local $last i32)
    (if (i32.eqz (local.get $ptr)) (then (return (i32.const 1))))
    ;; A zero-length range is readable by definition; Windows says so too.
    (if (i32.eqz (local.get $len)) (then (return (i32.const 0))))
    (local.set $last (i32.add (local.get $ptr) (i32.sub (local.get $len) (i32.const 1))))
    (if (i32.lt_u (local.get $last) (local.get $ptr)) (then (return (i32.const 1))))
    (if (i32.eq (call $g2w (local.get $ptr)) (global.get $NULL_SENTINEL))
      (then (return (i32.const 1))))
    (if (i32.eq (call $g2w (local.get $last)) (global.get $NULL_SENTINEL))
      (then (return (i32.const 1))))
    (i32.const 0))

  ;; 343: IsBadReadPtr(lp, ucb) → BOOL. Nonzero means the range is NOT readable.
  (func $handle_IsBadReadPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $ptr_range_bad (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 344: IsBadWritePtr(lp, ucb) → BOOL. Every page we can address is writable
  ;; here, so readability is the whole question.
  (func $handle_IsBadWritePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $ptr_range_bad (local.get $arg0) (local.get $arg1)))
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

  ;; SetProcessShutdownParameters(dwLevel, dwFlags) — record the process's
  ;; shutdown ordering so the matching Get* returns what was set. Explorer sets
  ;; a low level so it shuts down after the apps it hosts.
  (func $handle_SetProcessShutdownParameters (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $shutdown_level (local.get $arg0))
    (global.set $shutdown_flags (local.get $arg1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; GetProcessShutdownParameters(lpdwLevel, lpdwFlags) — report stored values.
  (func $handle_GetProcessShutdownParameters (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (i32.store (call $g2w (local.get $arg0)) (global.get $shutdown_level))))
    (if (local.get $arg1)
      (then (i32.store (call $g2w (local.get $arg1)) (global.get $shutdown_flags))))
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

  ;; 1266: GetUpdateRgn(hWnd, hRgn, bErase) — copy updateRgn into hRgn.
  (func $handle_GetUpdateRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rv i32)
    (local.set $rv (call $update_get_rect (local.get $arg0) (global.get $PAINT_SCRATCH)))
    (if (i32.and (i32.ne (local.get $rv) (i32.const 0)) (i32.ne (local.get $arg1) (i32.const 0)))
      (then
        (drop (call $gdi_rgn_set_rect
          (local.get $arg1)
          (i32.load (global.get $PAINT_SCRATCH))
          (i32.load offset=4 (global.get $PAINT_SCRATCH))
          (i32.load offset=8 (global.get $PAINT_SCRATCH))
          (i32.load offset=12 (global.get $PAINT_SCRATCH))))))
    (global.set $eax (select (i32.const 1) (i32.const 0) (local.get $rv)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 346: IsDebuggerPresent — return 0 — STUB: unimplemented
  (func $handle_IsDebuggerPresent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 347: lstrcpynW — copy up to n wide chars
  (func $handle_lstrcpynW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $lstr_cpyn (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 1))
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

  ;; 352: IsDBCSLeadByte(ch)
  (func $handle_IsDBCSLeadByte (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $is_dbcs_lead_byte (local.get $arg0)))
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
    (call $lstr_cat (local.get $arg0) (local.get $arg1) (i32.const 1))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 356: GlobalHandle — our GlobalLock returns ptr as-is, so GlobalHandle returns same value
  (func $handle_GlobalHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

ctl32 can route an ANSI status-bar string through ExtTextOutW
  ;; as packed byte pairs. Recognize only a printable byte string terminated
  ;; within the supplied UTF-16 span; ordinary UTF-16 ASCII has zero high
  ;; bytes and cannot match. The count can extend past the ANSI terminator
  ;; because the control obtained it by running lstrlenW over the byte buffer.
  (func $gdi_ext_text_out_w_packed_ansi_len (param $text i32) (param $count i32) (result i32)
    (local $i i32) (local $limit i32) (local $ch i32)
    (if (i32.or (i32.eqz (local.get $text))
          (i32.or (i32.le_s (local.get $count) (i32.const 0))
            (i32.gt_u (local.get $count) (i32.const 0x7FFF))))
      (then (return (i32.const 0))))
    (if (i32.eqz (i32.load8_u offset=1 (local.get $text)))
      (then (return (i32.const 0))))
    (local.set $limit (i32.shl (local.get $count) (i32.const 1)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $limit)))
      (local.set $ch (i32.load8_u (i32.add (local.get $text) (local.get $i))))
      (if (i32.eqz (local.get $ch))
        (then (return (local.get $i))))
      (if (i32.and
            (i32.or (i32.lt_u (local.get $ch) (i32.const 0x20))
              (i32.gt_u (local.get $ch) (i32.const 0x7E)))
            (i32.and (i32.ne (local.get $ch) (i32.const 9))
              (i32.and (i32.ne (local.get $ch) (i32.const 10))
                (i32.ne (local.get $ch) (i32.const 13)))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (i32.load8_u (i32.add (local.get $text) (local.get $limit))))
      (then (return (local.get $limit))))
    (i32.const 0))

rushOrgEx(hdc, x, y, lppt) — canonical WAT-owned brush origin.
  (func $handle_SetBrushOrgEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $old_x i32) (local $old_y i32) (local $aux i32)
    (local.set $aux (call $gdi_dc_aux_entry (local.get $arg0) (i32.const 1)))
    (if (i32.eqz (local.get $aux))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $old_x (call $gdi_dc_aux_get (local.get $arg0) (i32.const 8) (i32.const 0)))
    (local.set $old_y (call $gdi_dc_aux_get (local.get $arg0) (i32.const 12) (i32.const 0)))
    (if (local.get $arg3)
      (then
        (local.set $wa (call $g2w (local.get $arg3)))
        (i32.store (local.get $wa) (local.get $old_x))
        (i32.store (i32.add (local.get $wa) (i32.const 4)) (local.get $old_y))
      )
    )
    (drop (call $gdi_dc_aux_set (local.get $arg0) (i32.const 8)
      (local.get $arg1) (i32.const 0)))
    (drop (call $gdi_dc_aux_set (local.get $arg0) (i32.const 12)
      (local.get $arg2) (i32.const 0)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

HookEx — no next hook in chain, return 0
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
    ;; SetWindowsHookExW(idHook, lpfn, hMod, dwThreadId)
    ;; Save CBT hook proc (WH_CBT = 5) for CreateWindowEx* to call.
    (if (i32.eq (local.get $arg0) (i32.const 5))
      (then (global.set $cbt_hook_proc (local.get $arg1))))
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

  ;; 382: RedrawWindow(hwnd, lprcUpdate, hrgnUpdate, flags). Minimal:
  ;; treat as InvalidateRect/Rgn. RDW_VALIDATE (flags & 8) clears instead.
  ;; Other flag nuances (RDW_FRAME, RDW_UPDATENOW, RDW_NOCHILDREN) ignored.
  (func $handle_RedrawWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $l i32) (local $t i32) (local $r i32) (local $b i32) (local $wa i32) (local $cs i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
    ;; Derive rect: lprcUpdate if set, else hrgnUpdate bbox, else full client.
    (if (local.get $arg1)
      (then
        (local.set $wa (call $g2w (local.get $arg1)))
        (local.set $l (i32.load (local.get $wa)))
        (local.set $t (i32.load offset=4 (local.get $wa)))
        (local.set $r (i32.load offset=8 (local.get $wa)))
        (local.set $b (i32.load offset=12 (local.get $wa))))
      (else
        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
        (local.set $l (i32.const 0)) (local.set $t (i32.const 0))
        (local.set $r (i32.and (local.get $cs) (i32.const 0xFFFF)))
        (local.set $b (i32.shr_u (local.get $cs) (i32.const 16)))))
    (if (i32.and (local.get $arg3) (i32.const 0x8))  ;; RDW_VALIDATE
      (then
        (drop (call $update_validate_rect (local.get $arg0) (local.get $l) (local.get $t) (local.get $r) (local.get $b))))
      (else
        (call $update_invalidate_rect (local.get $arg0) (local.get $l) (local.get $t) (local.get $r) (local.get $b))
        (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
          (then (global.set $paint_pending (i32.const 1)))
          (else (call $paint_flag_set (local.get $arg0))))
        (call $host_invalidate (local.get $arg0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
  )

  ;; 383: ValidateRect(hwnd, lprc). lprc=NULL → full client (clear all).
  (func $handle_ValidateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $l i32) (local $t i32) (local $r i32) (local $b i32) (local $wa i32) (local $cs i32) (local $empty i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (local.get $arg1)
      (then
        (local.set $wa (call $g2w (local.get $arg1)))
        (local.set $l (i32.load (local.get $wa)))
        (local.set $t (i32.load offset=4 (local.get $wa)))
        (local.set $r (i32.load offset=8 (local.get $wa)))
        (local.set $b (i32.load offset=12 (local.get $wa))))
      (else
        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
        (local.set $l (i32.const 0)) (local.set $t (i32.const 0))
        (local.set $r (i32.and (local.get $cs) (i32.const 0xFFFF)))
        (local.set $b (i32.shr_u (local.get $cs) (i32.const 16)))))
    (local.set $empty (call $update_validate_rect (local.get $arg0) (local.get $l) (local.get $t) (local.get $r) (local.get $b)))
    (if (i32.and (i32.ne (local.get $empty) (i32.const 0))
                 (i32.eq (local.get $arg0) (global.get $main_hwnd)))
      (then (global.set $paint_pending (i32.const 0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 384: GetWindowDC(hwnd) → HDC. Like GetDC but includes non-client area.
  ;; Phase B: alloc DcRecord with kind='whole' so origin is window top-left.
  (func $handle_GetWindowDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hdc i32)
    ;; GetDesktopWindow returns our fixed pseudo HWND 0x10000. It has no
    ;; ordinary window-table geometry, so binding a window DC to it fails and
    ;; MFC's CWindowDC constructor throws CResourceException. Native Windows
    ;; treats both NULL and the desktop HWND as requests for a screen DC.
    (if (i32.or (i32.eqz (local.get $arg0))
          (i32.eq (local.get $arg0) (i32.const 0x10000)))
      (then (local.set $hdc (call $host_alloc_screen_dc)))
      (else
        (local.set $hdc (call $host_alloc_window_dc (local.get $arg0) (i32.const 1)))
        (if (local.get $hdc)
          (then (call $dc_apply_window_clip (local.get $hdc) (local.get $arg0))))))
    (global.set $eax (local.get $hdc))
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

  ;; DrawTextExW
  (func $handle_DrawTextExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $draw_text_ex
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
  )

  ;; 387: TabbedTextOutW — same WAT layout path with UTF-16 runs.
  (func $handle_TabbedTextOutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_tabbed_text
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
      (i32.const 1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 388: DestroyIcon(hIcon) — 1 arg stdcall, return TRUE
  (func $handle_DestroyIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; One LOGFONT{A,W} of system-font defaults at $buf. The two structs differ
  ;; only in lfFaceName's element width — 28 bytes of fields, then 32 chars —
  ;; so the whole NONCLIENTMETRICS layout below shifts with $wide and cannot be
  ;; written with static offsets.
  (func $spi_write_logfont (param $buf i32) (param $wide i32)
    (local $i i32) (local $ch i32)
    (i32.store offset=0  (local.get $buf) (i32.const -11))  ;; lfHeight
    (i32.store offset=16 (local.get $buf) (i32.const 400))  ;; lfWeight
    ;; lfFaceName at +28: "MS Sans Serif" from the shared constant at 0x270.
    (local.set $i (i32.const 0))
    (block $done (loop $copy
      (local.set $ch (i32.load8_u (i32.add (i32.const 0x270) (local.get $i))))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (local.get $wide)
        (then (i32.store16
                (i32.add (i32.add (local.get $buf) (i32.const 28))
                         (i32.shl (local.get $i) (i32.const 1)))
                (local.get $ch)))
        (else (i32.store8
                (i32.add (i32.add (local.get $buf) (i32.const 28)) (local.get $i))
                (local.get $ch))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy))))

  ;; SystemParametersInfo{A,W}(uiAction, uiParam, pvParam, fWinIni) — one body,
  ;; $wide selects the string encoding. The W entry point used to be a 6-line
  ;; return-TRUE stub sitting directly above this implementation, so every W
  ;; caller got a success code and an untouched buffer.
  (func $spi_core (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $wide i32) (result i32)
    (local $buf i32) (local $i i32) (local $screen i32)
    (local $lf i32) (local $narrow i32) (local $p i32)
    ;; LOGFONTA is 60 bytes, LOGFONTW 92 — every offset past lfCaptionFont moves.
    (local.set $lf (if (result i32) (local.get $wide) (then (i32.const 92)) (else (i32.const 60))))
    ;; SPI_SETDESKWALLPAPER = 0x14. The host loads the named VFS bitmap and
    ;; interprets uiParam=0/1 as centered/tiled for the Win98 Paint commands.
    (if (i32.eq (local.get $arg0) (i32.const 0x14))
      (then
        (if (i32.eqz (local.get $arg2)) (then (return (i32.const 0))))
        ;; The host reads a NUL-terminated byte path, so a W caller's UTF-16
        ;; name has to be narrowed before it is handed over.
        (if (local.get $wide)
          (then
            (local.set $narrow (call $shellexec_narrow_w (local.get $arg2)))
            (if (i32.eqz (local.get $narrow)) (then (return (i32.const 0))))
            (local.set $i (call $host_set_wallpaper
              (call $g2w (local.get $narrow)) (local.get $arg1)))
            (call $heap_free (local.get $narrow))
            (return (local.get $i))))
        (return (call $host_set_wallpaper
          (call $g2w (local.get $arg2)) (local.get $arg1)))))
    ;; SPI_GETWORKAREA = 0x30: fill RECT with the usable desktop area.
    ;; We do not emulate taskbar reservation, so the work area is the screen.
    (if (i32.eq (local.get $arg0) (i32.const 0x30))
      (then
        (if (local.get $arg2)
          (then
            (local.set $buf (call $g2w (local.get $arg2)))
            (local.set $screen (call $host_get_screen_size))
            (i32.store        (local.get $buf) (i32.const 0))
            (i32.store offset=4  (local.get $buf) (i32.const 0))
            (i32.store offset=8  (local.get $buf) (i32.and (local.get $screen) (i32.const 0xFFFF)))
            (i32.store offset=12 (local.get $buf) (i32.shr_u (local.get $screen) (i32.const 16)))))
        (return (i32.const 1))))
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
            ;; Five LOGFONTs at their real struct offsets. The A path used to
            ;; place them at 84/148/212/276 — that spacing skips the two
            ;; iSmCaption and two iMenu ints, so every font after the caption
            ;; font landed inside the preceding one. Real layout:
            ;;   lfCaptionFont   24
            ;;   iSmCaptionWidth/Height  24+lf, +4
            ;;   lfSmCaptionFont 32+lf
            ;;   iMenuWidth/Height       32+2lf, +4
            ;;   lfMenuFont      40+2lf
            ;;   lfStatusFont    40+3lf
            ;;   lfMessageFont   40+4lf
            ;; cbSize is therefore 340 (A) / 500 (W).
            (local.set $p (i32.add (local.get $buf) (i32.const 24)))
            (call $spi_write_logfont (local.get $p) (local.get $wide))
            (local.set $p (i32.add (local.get $p) (local.get $lf)))
            (i32.store offset=0 (local.get $p) (i32.const 12))  ;; iSmCaptionWidth
            (i32.store offset=4 (local.get $p) (i32.const 15))  ;; iSmCaptionHeight
            (local.set $p (i32.add (local.get $p) (i32.const 8)))
            (call $spi_write_logfont (local.get $p) (local.get $wide))
            (local.set $p (i32.add (local.get $p) (local.get $lf)))
            (i32.store offset=0 (local.get $p) (i32.const 18))  ;; iMenuWidth
            (i32.store offset=4 (local.get $p) (i32.const 18))  ;; iMenuHeight
            (local.set $p (i32.add (local.get $p) (i32.const 8)))
            (call $spi_write_logfont (local.get $p) (local.get $wide))  ;; lfMenuFont
            (local.set $p (i32.add (local.get $p) (local.get $lf)))
            (call $spi_write_logfont (local.get $p) (local.get $wide))  ;; lfStatusFont
            (local.set $p (i32.add (local.get $p) (local.get $lf)))
            (call $spi_write_logfont (local.get $p) (local.get $wide)))) ;; lfMessageFont
        (return (i32.const 1))))
    (i32.const 1))

  ;; 389: SystemParametersInfoW — 4 args stdcall
  (func $handle_SystemParametersInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $spi_core (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; SystemParametersInfoA(uiAction, uiParam, pvParam, fWinIni) — 4 args stdcall
  (func $handle_SystemParametersInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $spi_core (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 390: IsWindowVisible
  (func $handle_IsWindowVisible (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (i32.ge_s (call $wnd_table_find (local.get $arg0)) (i32.const 0))
        (then
          (if (result i32) (i32.and (call $wnd_get_style (local.get $arg0)) (i32.const 0x10000000))
            (then (i32.const 1))
            (else (i32.const 0))))
        (else (call $host_get_window_info (local.get $arg0) (i32.const 1)))))
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

  ;; 392: LoadBitmapW
  (func $handle_LoadBitmapW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_bitmap_load_resource
      (local.get $arg0) (local.get $arg1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 393: wvsprintfW — STUB: unimplemented
  ;; wvsprintfW(lpOut, lpFmt, arglist) — the W twin of wvsprintfA, using the
  ;; same wide implementation wsprintfW already goes through. The only
  ;; difference from wsprintfW is where the arguments come from: an explicit
  ;; va_list pointer rather than the caller's stack. NT Paint formats its
  ;; Stretch/Skew dialog through this, and trapped here.
  (func $handle_wvsprintfW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wsprintf_impl_w
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 121: DrawFocusRect(hdc, lprc)
  (func $handle_DrawFocusRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rc i32) (local $desc i32)
    (local.set $rc (call $g2w (local.get $arg1)))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_focus_rect_desc
        (local.get $arg0) (local.get $desc)
        (i32.load (local.get $rc)) (i32.load offset=4 (local.get $rc))
        (i32.load offset=8 (local.get $rc)) (i32.load offset=12 (local.get $rc)))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; ret + 2 args
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

  ;; 396: WinHelpW — normalize UTF-16 and share the WinHelpA engine
  (func $handle_WinHelpW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $accepted i32)
    (local.set $accepted (call $help_dispatch_api_w
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (call $help_present_dispatch (local.get $accepted) (local.get $arg2))
    (global.set $eax (local.get $accepted))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 397: GetCapture — STUB: unimplemented
  (func $handle_GetCapture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetCapture() — 0 args, returns hwnd that has mouse capture (or NULL)
    (global.set $eax (global.get $capture_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; 0 args
  )

  ;; 398: RegisterClipboardFormatW(lpszFormat) → UINT
  ;; Returns a registered clipboard format ID. "Rich Text Format" is stable so
  ;; Set/GetClipboardData can recognize the non-OLE RTF payload.
  (func $handle_RegisterClipboardFormatW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (call $clipboard_register_format_w (local.get $arg0)))
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

  ;; 401: UnionRect(lprcDst, lprcSrc1, lprcSrc2) → BOOL
  (func $handle_UnionRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst i32) (local $s1 i32) (local $s2 i32)
    (local $s1l i32) (local $s1t i32) (local $s1r i32) (local $s1b i32)
    (local $s2l i32) (local $s2t i32) (local $s2r i32) (local $s2b i32)
    (local $e1 i32) (local $e2 i32)
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
    (local.set $e1 (i32.or
      (i32.ge_s (local.get $s1l) (local.get $s1r))
      (i32.ge_s (local.get $s1t) (local.get $s1b))))
    (local.set $e2 (i32.or
      (i32.ge_s (local.get $s2l) (local.get $s2r))
      (i32.ge_s (local.get $s2t) (local.get $s2b))))
    (if (i32.and (local.get $e1) (local.get $e2))
      (then
        (i32.store (local.get $dst) (i32.const 0))
        (i32.store offset=4 (local.get $dst) (i32.const 0))
        (i32.store offset=8 (local.get $dst) (i32.const 0))
        (i32.store offset=12 (local.get $dst) (i32.const 0))
        (global.set $eax (i32.const 0)))
      (else
        (if (local.get $e1)
          (then
            (i32.store (local.get $dst) (local.get $s2l))
            (i32.store offset=4 (local.get $dst) (local.get $s2t))
            (i32.store offset=8 (local.get $dst) (local.get $s2r))
            (i32.store offset=12 (local.get $dst) (local.get $s2b)))
          (else
            (if (local.get $e2)
              (then
                (i32.store (local.get $dst) (local.get $s1l))
                (i32.store offset=4 (local.get $dst) (local.get $s1t))
                (i32.store offset=8 (local.get $dst) (local.get $s1r))
                (i32.store offset=12 (local.get $dst) (local.get $s1b)))
              (else
                (i32.store (local.get $dst)
                  (select (local.get $s1l) (local.get $s2l) (i32.lt_s (local.get $s1l) (local.get $s2l))))
                (i32.store offset=4 (local.get $dst)
                  (select (local.get $s1t) (local.get $s2t) (i32.lt_s (local.get $s1t) (local.get $s2t))))
                (i32.store offset=8 (local.get $dst)
                  (select (local.get $s1r) (local.get $s2r) (i32.gt_s (local.get $s1r) (local.get $s2r))))
                (i32.store offset=12 (local.get $dst)
                  (select (local.get $s1b) (local.get $s2b) (i32.gt_s (local.get $s1b) (local.get $s2b))))))))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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

  ;; 402: WindowFromPoint(POINT pt) → HWND. POINT is passed by value as two
  ;; dwords on the stack, so arg0=x, arg1=y. We don't have a screen-wide
  ;; top-level window registry, so return main_hwnd as the best-effort
  ;; answer — mspaint calls this during pencil drags to verify the cursor
  ;; is still inside the app, and returning 0 would abort the drag.
  (func $handle_WindowFromPoint (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $main_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 403: IsRectEmpty — STUB: unimplemented
  ;; IsRectEmpty(lpRect=arg0) → BOOL. Empty iff right<=left OR bottom<=top.
  (func $handle_IsRectEmpty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $r i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (return)))
    (local.set $r (call $g2w (local.get $arg0)))
    (global.set $eax
      (i32.or
        (i32.le_s (i32.load (i32.add (local.get $r) (i32.const 8)))   ;; right
                  (i32.load (local.get $r)))                             ;; left
        (i32.le_s (i32.load (i32.add (local.get $r) (i32.const 12)))  ;; bottom
                  (i32.load (i32.add (local.get $r) (i32.const 4))))))  ;; top
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
    (local $pt i32) (local $ox i32) (local $oy i32)
    (local.set $pt (call $g2w (local.get $arg1)))
    (local.set $ox (call $wnd_client_screen_x (local.get $arg0)))
    (local.set $oy (call $wnd_client_screen_y (local.get $arg0)))
    (i32.store (local.get $pt)
      (i32.add (i32.load (local.get $pt)) (local.get $ox)))
    (i32.store offset=4 (local.get $pt)
      (i32.add (i32.load offset=4 (local.get $pt)) (local.get $oy)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 406: SetActiveWindow(hwnd) — return previous active window (fake: return arg)
  (func $handle_SetActiveWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

;; 408: SetFilePointer — STUB: unimplemented
  (func $handle_SetFilePointer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetFilePointer(hFile, lDistanceToMove, lpDistanceToMoveHigh, dwMoveMethod) — 4 args
    (global.set $eax (call $host_fs_set_file_pointer
      (local.get $arg0) (local.get $arg1) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; ResumeThread(hThread) — 1 arg stdcall, return previous suspend count
  (func $handle_ResumeThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_resume_thread (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 410: SetLastError(dwErrCode)
  (func $handle_SetLastError (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $last_error (local.get $arg0))
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
    ;; Borland shipped two "this is a Delphi exception" codes over the years:
    ;; the older RTLs raise 0x0EEDFACE and the later ones 0x0EEDFADE. Both mean
    ;; the same thing and both need the Delphi handler protocol, so recognising
    ;; only one sends the other into $raise_exception, which walks the chain
    ;; expecting MSVC-shaped frames and lands on a garbage EIP.
    (if (i32.or
          (i32.eq (local.get $arg0) (i32.const 0x0eedfade))
          (i32.eq (local.get $arg0) (i32.const 0x0eedface)))
      (then
        (call $raise_delphi_exception (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3))
        (return)))
    (call $raise_exception (local.get $arg0))
  )

  ;; 413: GetUserDefaultLCID — STUB: unimplemented
  (func $handle_GetUserDefaultLCID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return 0x0409 = English (US)
    (global.set $eax (i32.const 0x0409))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; GetSystemDefaultLCID() -> LCID. RichEdit asks during DLL init.
  (func $handle_GetSystemDefaultLCID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0409))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; GetSystemDefaultLangID() -> LANGID. Match US English locale stubs.
  (func $handle_GetSystemDefaultLangID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0409))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 414: FileTimeToSystemTime — STUB: unimplemented
  (func $handle_FileTimeToSystemTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; FileTimeToSystemTime(lpFileTime, lpSystemTime) — 2 args
    (global.set $eax (call $host_fs_filetime_to_systemtime
      (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args
  )

  ;; FileTimeToDosDateTime(lpFileTime, LPWORD lpFatDate, LPWORD lpFatTime)
  ;; — 3 args stdcall. The FAT packing MS-DOS used, and still what a ZIP
  ;; directory entry stores, which is why archive code reaches for it.
  ;;
  ;; Built on the SYSTEMTIME conversion we already have rather than redoing
  ;; the 1601-epoch arithmetic: the calendar is the hard part and it is
  ;; already solved. The scratch SYSTEMTIME is ours alone, so it comes from
  ;; the heap once and is reused.
  (global $dosdate_scratch (mut i32) (i32.const 0))
  (func $handle_FileTimeToDosDateTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $st i32) (local $year i32)
    (if (i32.eqz (global.get $dosdate_scratch))
      (then (global.set $dosdate_scratch (call $heap_alloc (i32.const 16)))))
    (if (i32.eqz (global.get $dosdate_scratch))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $st (call $g2w (global.get $dosdate_scratch)))
    (if (i32.eqz (call $host_fs_filetime_to_systemtime
                   (call $g2w (local.get $arg0)) (local.get $st)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; The FAT epoch is 1980, and the field is 7 bits wide. Anything outside
    ;; 1980..2107 has no representation at all; Win32 reports failure rather
    ;; than wrapping into a wrong-but-plausible date.
    (local.set $year (i32.load16_u (local.get $st)))
    (if (i32.or (i32.lt_u (local.get $year) (i32.const 1980))
                (i32.gt_u (local.get $year) (i32.const 2107)))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (if (local.get $arg1)
      (then (i32.store16 (call $g2w (local.get $arg1))
        (i32.or
          (i32.shl (i32.sub (local.get $year) (i32.const 1980)) (i32.const 9))
          (i32.or
            (i32.shl (i32.load16_u offset=2 (local.get $st)) (i32.const 5))
            (i32.load16_u offset=6 (local.get $st)))))))
    (if (local.get $arg2)
      (then (i32.store16 (call $g2w (local.get $arg2))
        (i32.or
          (i32.shl (i32.load16_u offset=8 (local.get $st)) (i32.const 11))
          (i32.or
            (i32.shl (i32.load16_u offset=10 (local.get $st)) (i32.const 5))
            ;; Two-second resolution: the low bit does not exist in FAT.
            (i32.shr_u (i32.load16_u offset=12 (local.get $st)) (i32.const 1)))))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 415: FileTimeToLocalFileTime(const FILETIME *src, LPFILETIME dst) → BOOL.
  ;; 2-arg stdcall. We don't model timezones — just copy the 8 bytes.
  (func $handle_FileTimeToLocalFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $s i32) (local $d i32)
    (local.set $s (call $g2w (local.get $arg0)))
    (local.set $d (call $g2w (local.get $arg1)))
    (i32.store (local.get $d) (i32.load (local.get $s)))
    (i32.store (i32.add (local.get $d) (i32.const 4)) (i32.load (i32.add (local.get $s) (i32.const 4))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; 421: SetEndOfFile
  (func $handle_SetEndOfFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; SetEndOfFile(hFile) — truncate or extend at the current file pointer.
    (global.set $eax (call $host_fs_set_end_of_file (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 422: DuplicateHandle
  (func $handle_DuplicateHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Kernel object handles in this runtime are stable process-local IDs, so a
    ;; duplicate can share the same value. This also preserves pseudo handles
    ;; such as GetCurrentThread() == -2, which Allegro duplicates during setup.
    (if (local.get $arg3)
      (then (call $gs32 (local.get $arg3) (local.get $arg1))))
    (global.set $eax (i32.ne (local.get $arg3) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))) ;; 7 args + ret
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

  ;; 428: LocalFileTimeToFileTime. The emulator does not model a timezone, so
  ;; local and UTC FILETIMEs have the same bit representation.
  (func $handle_LocalFileTimeToFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src i32) (local $dst i32)
    (if (i32.and (i32.ne (local.get $arg0) (i32.const 0)) (i32.ne (local.get $arg1) (i32.const 0)))
      (then
        (local.set $src (call $g2w (local.get $arg0)))
        (local.set $dst (call $g2w (local.get $arg1)))
        (i64.store (local.get $dst) (i64.load (local.get $src)))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; RegEnumKeyW(hKey, dwIndex, lpName, cchName)
  (func $handle_RegEnumKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_enum_key
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
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
  ;; GetShortPathNameA(lpszLongPath, lpszShortPath, cchBuffer) — 3 args.
  ;; Through the same host call the W spelling uses: this used to copy the
  ;; long path back verbatim, so the two spellings answered differently for
  ;; a path the VFS does have a short name for.
  (func $handle_GetShortPathNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_fs_get_short_path_name
      (call $g2w (local.get $arg0)) (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 453: ExtFloodFill(hdc, x, y, color, fillType)
  (func $handle_ExtFloodFill (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_BLIT_DST_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_raster_flood_fill
        (local.get $arg0) (local.get $desc) (local.get $arg1) (local.get $arg2)
        (local.get $arg3) (local.get $arg4)
        (call $gdi_dc_get_field (local.get $arg0) (i32.const 8) (i32.const 0x30010)))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

: EnableScrollBar(hWnd, wSBflags, wArrows) — we have no scroll bars,
  ;; so enabling/disabling is a no-op. Return TRUE so apps don't think the
  ;; call failed.
  (func $handle_EnableScrollBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) ;; 3 args stdcall
  )

  (func $caret_schedule_repaint
    (local $hwnd i32) (local $top i32)
    (local.set $hwnd (global.get $caret_hwnd))
    (if (i32.eqz (local.get $hwnd))
      (then (return)))
    (local.set $top (call $wnd_top_level (local.get $hwnd)))
    (if (i32.eqz (local.get $top))
      (then (local.set $top (local.get $hwnd))))
    ;; The renderer composites USER caret state after normal back-canvas paint.
    ;; Scheduling the top-level repaint is enough; direct GDI fills here can land
    ;; before native child layout has settled and then get erased by repaint.
    (call $host_invalidate (local.get $top))
  )

  ;; 459: GetCaretPos(lpPoint) — report the last USER caret coordinates.
  (func $handle_GetCaretPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then
        (i32.store (call $g2w (local.get $arg0)) (global.get $caret_x))
        (i32.store (i32.add (call $g2w (local.get $arg0)) (i32.const 4)) (global.get $caret_y))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; 1 arg stdcall
  )

  ;; GetCaretBlinkTime() — the interval a caret spends in each phase. Callers
  ;; use it as a timer period, so returning a real value matters: HyperTerminal
  ;; feeds it straight to SetTimer for its cursor.
  (func $handle_GetCaretBlinkTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $caret_blink_time))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) ;; 0 args stdcall
  )

  ;; SetCaretBlinkTime(uMSeconds) — store it so the Get above reports it back.
  (func $handle_SetCaretBlinkTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (global.set $caret_blink_time (local.get $arg0))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; 1 arg stdcall
  )

  ;; Caret APIs — enough USER caret state for native controls such as RichEdit
  ;; to leave a visible caret stroke in the renderer. The renderer composites
  ;; this state after normal back-canvas paint and owns blink/inverted erasure.
  (func $handle_CreateCaret (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $caret_hwnd (local.get $arg0))
    (global.set $caret_x (i32.const 0))
    (global.set $caret_y (i32.const 0))
    (if (i32.gt_s (local.get $arg2) (i32.const 0))
      (then (global.set $caret_w (local.get $arg2)))
      (else (global.set $caret_w (i32.const 1))))
    (if (i32.gt_s (local.get $arg3) (i32.const 0))
      (then (global.set $caret_h (local.get $arg3)))
      (else (global.set $caret_h (i32.const 13))))
    (global.set $caret_visible (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) ;; 4 args stdcall
  )

  (func $handle_DestroyCaret (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $caret_visible (i32.const 0))
    (call $caret_schedule_repaint)
    (global.set $caret_hwnd (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) ;; 0 args stdcall
  )

  (func $handle_HideCaret (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or
          (i32.eqz (local.get $arg0))
          (i32.eq (local.get $arg0) (global.get $caret_hwnd)))
      (then
        (global.set $caret_visible (i32.const 0))
        (call $caret_schedule_repaint)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; 1 arg stdcall
  )

  (func $handle_ShowCaret (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0)
      (then (global.set $caret_hwnd (local.get $arg0))))
    (global.set $caret_visible (i32.const 1))
    (call $caret_schedule_repaint)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; 1 arg stdcall
  )

  (func $handle_SetCaretPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $caret_x (local.get $arg0))
    (global.set $caret_y (local.get $arg1))
    (if (global.get $caret_visible)
      (then (call $caret_schedule_repaint)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) ;; 2 args stdcall
  )

  ;; 460: GetUpdateRect(hwnd, lpRect, bErase) — writes updateRgn bbox if present;
  ;; otherwise writes the full client rect (back-compat fallback for apps that
  ;; check this on startup before any Invalidate). Returns TRUE iff non-empty.
  (func $handle_GetUpdateRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rv i32) (local $wa i32) (local $cs i32)
    (if (local.get $arg1)
      (then
        (local.set $wa (call $g2w (local.get $arg1)))
        (local.set $rv (call $update_get_rect (local.get $arg0) (local.get $wa)))
        (if (i32.eqz (local.get $rv))
          (then
            ;; Empty updateRgn. If paint_pending (main) or paint flag set (child),
            ;; the caller will paint full client — hand them the full client rect.
            (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
            (i32.store (local.get $wa) (i32.const 0))
            (i32.store offset=4 (local.get $wa) (i32.const 0))
            (i32.store offset=8 (local.get $wa) (i32.and (local.get $cs) (i32.const 0xFFFF)))
            (i32.store offset=12 (local.get $wa) (i32.shr_u (local.get $cs) (i32.const 16)))
            (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
              (then (local.set $rv (global.get $paint_pending)))))))
      (else (local.set $rv (call $update_get_rect (local.get $arg0) (i32.const 0)))))
    (global.set $eax (local.get $rv))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

;; 462: WriteClassStg(pStg, rclsid) — persist the root storage CLSID.
  (func $handle_WriteClassStg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then (global.set $eax (i32.const 0x80004003)))
      (else
        (memory.copy (call $g2w (i32.add (local.get $arg0) (i32.const 20))) (call $g2w (local.get $arg1)) (i32.const 16))
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 463: WriteFmtUserTypeStg(pStg, cf, lpszUserType) — no-op success.
  (func $handle_WriteFmtUserTypeStg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0)) ;; S_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
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
  ;; OleUIAddVerbMenuA(lpOleObj, lpszShortType, hMenu, uPos, uIDVerbMin,
  ;;                   uIDVerbMax, bAddConvert, idConvert, lphMenu) → BOOL
  ;;
  ;; MFC builds the "<<OLE VERBS GO HERE>>" entry of an Edit menu through this,
  ;; from its WM_INITMENUPOPUP handler. It was not registered, so
  ;; GetProcAddress("OleUIAddVerbMenuA") returned 0 and MFC put up "This
  ;; program is linked to the missing export ... in OLEDLG.DLL" -- which only
  ;; became visible once WM_INITMENUPOPUP started being delivered at all.
  ;;
  ;; With no object selected there are no verbs to add, and FALSE with
  ;; *lphMenu = NULL is the documented answer, not a placeholder. An actual
  ;; embedded object would need IOleObject::EnumVerbs, so that case still
  ;; fails loudly rather than silently doing nothing.
  (func $handle_OleUIAddVerbMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lphMenu i32)
    (if (local.get $arg0)
      (then (call $crash_unimplemented (local.get $name_ptr))))
    (local.set $lphMenu (call $gl32 (i32.add (global.get $esp) (i32.const 36))))
    (if (local.get $lphMenu)
      (then (call $gs32 (local.get $lphMenu) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))  ;; 9 args
  )

  ;; ShellAboutW(hwnd, szApp, szOtherStuff, hIcon) — the W twin of
  ;; ShellAboutA, which builds the whole dialog in WAT. This returned TRUE
  ;; without drawing anything, so XP Minesweeper's Help > About Minesweeper...
  ;; reported success and showed nothing.
  ;;
  ;; The narrowed copies are deliberately not freed: $create_about_dialog hands
  ;; the body string straight to a STATIC that keeps the pointer, and these
  ;; heap copies outlive the call in a way the caller's own stack buffers
  ;; (0x080ffc94 in Minesweeper's case) would not.
  (func $handle_ShellAboutW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $app i32) (local $other i32)
    (local.set $app (call $atom_narrow_w (local.get $arg1)))
    (if (local.get $arg2)
      (then (local.set $other (call $atom_narrow_w (local.get $arg2)))))
    (if (local.get $app)
      (then
        (local.set $dlg (global.get $next_hwnd))
        (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
        (drop (call $host_shell_about
          (local.get $dlg) (local.get $arg0) (call $g2w (local.get $app))))
        (call $create_about_dialog
          (local.get $dlg) (local.get $arg0) (local.get $app) (local.get $other))))
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
  ;; ShellExecuteW(hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShow)
  ;; Narrow the four strings and take the same host path as the A form. This
  ;; returned 33 ("succeeded") without looking at a single argument, so a
  ;; Unicode app's shell request vanished with no log and no failure code --
  ;; XP Sound Recorder's Edit > Audio Properties asks for
  ;; RUNDLL32.EXE MMSYS.CPL,ShowAudioPropertySheet here and appeared to do
  ;; nothing at all. Routing it through $host_shell_execute at least makes the
  ;; request observable; what the host does with rundll32 is its business.
  (func $handle_ShellExecuteW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $op i32) (local $file i32) (local $params i32) (local $dir i32)
    (local.set $op    (call $shellexec_narrow_w (local.get $arg1)))
    (local.set $file  (call $shellexec_narrow_w (local.get $arg2)))
    (local.set $params (call $shellexec_narrow_w (local.get $arg3)))
    (local.set $dir   (call $shellexec_narrow_w (local.get $arg4)))
    (global.set $eax (call $host_shell_execute
      (local.get $arg0)
      (if (result i32) (local.get $op)    (then (call $g2w (local.get $op)))    (else (i32.const 0)))
      (if (result i32) (local.get $file)  (then (call $g2w (local.get $file)))  (else (i32.const 0)))
      (if (result i32) (local.get $params) (then (call $g2w (local.get $params))) (else (i32.const 0)))
      (if (result i32) (local.get $dir)   (then (call $g2w (local.get $dir)))   (else (i32.const 0)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))))  ;; nShowCmd
    (if (local.get $op)     (then (call $heap_free (local.get $op))))
    (if (local.get $file)   (then (call $heap_free (local.get $file))))
    (if (local.get $params) (then (call $heap_free (local.get $params))))
    (if (local.get $dir)    (then (call $heap_free (local.get $dir))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; UTF-16 → a fresh guest ANSI buffer, or 0 for a NULL argument. Caller frees.
  (func $shellexec_narrow_w (param $ws i32) (result i32)
    (local $n i32) (local $buf i32)
    (if (i32.eqz (local.get $ws)) (then (return (i32.const 0))))
    (local.set $n (i32.add (call $guest_wcslen (local.get $ws)) (i32.const 1)))
    (local.set $buf (call $heap_alloc (local.get $n)))
    (if (i32.eqz (local.get $buf)) (then (return (i32.const 0))))
    (drop (call $wide_to_ansi (local.get $ws) (local.get $buf) (local.get $n)))
    (local.get $buf))

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

  ;; SHGetFileInfo's display name: the final component of the path, copied into
  ;; SHFILEINFO.szDisplayName (byte 12, 260 characters). Both spellings come
  ;; here; $wide says how wide the caller's path and struct are.
  (func $sh_file_info_display_name
      (param $path i32) (param $psfi i32) (param $cb i32) (param $wide i32) (result i32)
    (local $step i32) (local $src i32) (local $base i32) (local $dst i32)
    (local $ch i32) (local $count i32)
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (if (i32.and (i32.ne (local.get $path) (i32.const 0))
                 (i32.and (i32.ne (local.get $psfi) (i32.const 0))
                          (i32.ge_u (local.get $cb) (i32.const 14))))
      (then
        (local.set $src (local.get $path))
        (local.set $base (local.get $path))
        ;; Find the final path component without modifying the caller's path.
        (block $scan_done (loop $scan
          (local.set $ch (if (result i32) (local.get $wide)
            (then (call $gl16 (local.get $src))) (else (call $gl8 (local.get $src)))))
          (br_if $scan_done (i32.eqz (local.get $ch)))
          (if (i32.or (i32.eq (local.get $ch) (i32.const 47))
                      (i32.eq (local.get $ch) (i32.const 92)))
            (then (local.set $base (i32.add (local.get $src) (local.get $step)))))
          (local.set $src (i32.add (local.get $src) (local.get $step)))
          (br $scan)))
        (local.set $src (local.get $base))
        (local.set $dst (i32.add (local.get $psfi) (i32.const 12)))
        (block $copy_done (loop $copy
          (br_if $copy_done (i32.ge_u (local.get $count) (i32.const 259)))
          (local.set $ch (if (result i32) (local.get $wide)
            (then (call $gl16 (local.get $src))) (else (call $gl8 (local.get $src)))))
          (br_if $copy_done (i32.eqz (local.get $ch)))
          (if (local.get $wide)
            (then (call $gs16
              (i32.add (local.get $dst) (i32.mul (local.get $count) (i32.const 2)))
              (local.get $ch)))
            (else (call $gs8
              (i32.add (local.get $dst) (local.get $count)) (local.get $ch))))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (local.set $src (i32.add (local.get $src) (local.get $step)))
          (br $copy)))
        (if (local.get $wide)
          (then (call $gs16
            (i32.add (local.get $dst) (i32.mul (local.get $count) (i32.const 2))) (i32.const 0)))
          (else (call $gs8
            (i32.add (local.get $dst) (local.get $count)) (i32.const 0))))))
    (if (result i32) (local.get $psfi) (then (i32.const 1)) (else (i32.const 0))))

  ;; SHGetFileInfoW(pszPath, attrs, psfi, cb, flags). Media Player asks for
  ;; SHGFI_DISPLAYNAME and uses szDisplayName in its caption.
  (func $handle_SHGetFileInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $sh_file_info_display_name
      (local.get $arg0) (local.get $arg2) (local.get $arg3) (i32.const 1)))
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

  ;; RunFileDlg(hwndOwner, hIcon, lpszDir, lpszTitle, lpszDesc, uFlags)
  ;; SHELL32 ordinal 61 — Task Manager's File > Run Application...
  ;;
  ;; Six arguments, not five: taskman pushes hwnd, 0, 0, &title, 0, 0 at
  ;; 0x402b9c..0x402ba4. The old stub popped five and left a dword of the
  ;; caller's frame on the stack every time it was called.
  ;;
  ;; The dialog is the shell's, so it is built here rather than by the app --
  ;; the caller supplies at most a title and a prompt.
  (func $handle_RunFileDlg (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_run_dialog
      (local.get $dlg) (local.get $arg0) (local.get $arg3) (local.get $arg4))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; 6 args + ret
  )

  ;; ExitWindowsDialog(hwndOwner) — SHELL32 ordinal 60, Task Manager's
  ;; File > Shutdown Windows... OK sets the quit flag, which is as far as
  ;; "shut down" goes when the emulator is the machine.
  (func $handle_ExitWindowsDialog (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_shutdown_dialog (local.get $dlg) (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; RegisterShellHook(hwnd, dwType) — legacy Win9x shell-window subscriber.
  ;; dwType=1 registers and dwType=0 unregisters. TASKMAN.EXE calls
  ;; RegisterWindowMessage("SHELLHOOK") immediately before this API.
  (func $handle_RegisterShellHook (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (local.get $arg1) (i32.const 1))
      (then
        (global.set $shell_hook_hwnd (local.get $arg0))
        (global.set $shell_hook_message (global.get $clipboard_format_counter)))
      (else
        (if (i32.eq (local.get $arg0) (global.get $shell_hook_hwnd))
          (then
            (global.set $shell_hook_hwnd (i32.const 0))
            (global.set $shell_hook_message (i32.const 0))))))
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

  ;; 471: GetEnvironmentVariableA(lpName, lpBuffer, nSize) → chars written
  (func $handle_GetEnvironmentVariableA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $env_get (local.get $arg0) (local.get $arg1) (local.get $arg2) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; Fill OSVERSIONINFO from $winver. Both spellings share this: the struct is
  ;; identical up to szCSDVersion, which is empty either way. The W handler
  ;; used to hardcode Windows 98 instead, so an app told (via $winver) that it
  ;; was running on NT still read 4.10 back if it asked in Unicode.
  ;; winver uses GetVersion format: high word = build (bit 31: set=Win9x, clear=NT)
  ;; low word = (minor<<8)|major
  (func $version_info (param $out_g i32)
    (local $w0 i32)
    (local.set $w0 (call $g2w (local.get $out_g)))
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
    ;; szCSDVersion at +20: empty string. Two zero bytes terminate it whether
    ;; the caller reads it as CHAR or WCHAR.
    (i32.store8 (i32.add (local.get $w0) (i32.const 20)) (i32.const 0))
    (i32.store8 (i32.add (local.get $w0) (i32.const 21)) (i32.const 0)))

  ;; 472: GetVersionExA — fill OSVERSIONINFOA (148 bytes min) from $winver
  (func $handle_GetVersionExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $version_info (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 473: SetConsoleCtrlHandler(HandlerRoutine, Add) → BOOL
  (func $handle_SetConsoleCtrlHandler (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 474: SetEnvironmentVariableW(lpName, lpValue) → BOOL
  (func $handle_SetEnvironmentVariableW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $env_set (local.get $arg0) (local.get $arg1) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; CompareString core, shared by both spellings: the comparison rules are the
  ;; same, only the character stride differs. $p1/$p2 are WASM addresses,
  ;; lengths are in characters and -1 means "NUL-terminated". Returns
  ;; CSTR_LESS_THAN(1), CSTR_EQUAL(2), CSTR_GREATER_THAN(3).
  (func $compare_string (param $flags i32) (param $p1 i32) (param $len1 i32)
                        (param $p2 i32) (param $len2 i32) (param $wide i32) (result i32)
    (local $i i32) (local $c1 i32) (local $c2 i32) (local $minlen i32) (local $step i32)
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (if (i32.eq (local.get $len1) (i32.const -1))
      (then (local.set $len1 (select
        (call $strlen_w (local.get $p1)) (call $strlen_a (local.get $p1)) (local.get $wide)))))
    (if (i32.eq (local.get $len2) (i32.const -1))
      (then (local.set $len2 (select
        (call $strlen_w (local.get $p2)) (call $strlen_a (local.get $p2)) (local.get $wide)))))
    (local.set $minlen (select (local.get $len1) (local.get $len2) (i32.lt_u (local.get $len1) (local.get $len2))))
    (block $cmp_done (loop $cmp
      (br_if $cmp_done (i32.ge_u (local.get $i) (local.get $minlen)))
      (local.set $c1 (call $load_char
        (i32.add (local.get $p1) (i32.mul (local.get $i) (local.get $step))) (local.get $wide)))
      (local.set $c2 (call $load_char
        (i32.add (local.get $p2) (i32.mul (local.get $i) (local.get $step))) (local.get $wide)))
      ;; NORM_IGNORECASE (flag 1): uppercase both
      (if (i32.and (local.get $flags) (i32.const 1))
        (then
          (if (i32.and (i32.ge_u (local.get $c1) (i32.const 97)) (i32.le_u (local.get $c1) (i32.const 122)))
            (then (local.set $c1 (i32.sub (local.get $c1) (i32.const 32)))))
          (if (i32.and (i32.ge_u (local.get $c2) (i32.const 97)) (i32.le_u (local.get $c2) (i32.const 122)))
            (then (local.set $c2 (i32.sub (local.get $c2) (i32.const 32)))))))
      (if (i32.lt_u (local.get $c1) (local.get $c2)) (then (return (i32.const 1))))
      (if (i32.gt_u (local.get $c1) (local.get $c2)) (then (return (i32.const 3))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cmp)))
    ;; Common prefix: the shorter string sorts first.
    (select (i32.const 1) (select (i32.const 3) (i32.const 2)
      (i32.gt_u (local.get $len1) (local.get $len2)))
      (i32.lt_u (local.get $len1) (local.get $len2))))

  ;; One character at a WASM address, ANSI or wide.
  (func $load_char (param $p i32) (param $wide i32) (result i32)
    (if (local.get $wide) (then (return (i32.load16_u (local.get $p)))))
    (i32.load8_u (local.get $p)))

  ;; 475: CompareStringA(Locale, dwCmpFlags, lpString1, cchCount1, lpString2, cchCount2) → int
  (func $handle_CompareStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; arg4 = lpString2, cchCount2 (6th arg) is still on the guest stack at esp+24
    (global.set $eax (call $compare_string (local.get $arg1)
      (call $g2w (local.get $arg2)) (local.get $arg3)
      (call $g2w (local.get $arg4)) (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 476: CompareStringW — same comparison, wide characters
  (func $handle_CompareStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $compare_string (local.get $arg1)
      (call $g2w (local.get $arg2)) (local.get $arg3)
      (call $g2w (local.get $arg4)) (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; 477: IsValidLocale(Locale, dwFlags) → BOOL
  (func $handle_IsValidLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 478: EnumSystemLocalesA(lpLocaleEnumProc, dwFlags) → BOOL — no-op
  (func $handle_EnumSystemLocalesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 479: GetLocaleInfoW(Locale, LCType, lpLCData, cchData) → chars written.
  ;; Same values as the A spelling, written as UTF-16 — see $locale_info.
  (func $handle_GetLocaleInfoW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $locale_info
      (local.get $arg1) (local.get $arg2) (local.get $arg3) (i32.const 1)))
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

  ;; 481: SetEnvironmentVariableA(lpName, lpValue) → BOOL
  (func $handle_SetEnvironmentVariableA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $env_set (local.get $arg0) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; 484: GetLogicalDrives() — return bitmask of drives (bits 2/3 = C:/D:)
  (func $handle_GetLogicalDrives (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0C))  ;; fixed C: plus CD-ROM D:
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))  ;; stdcall, 0 args
  )

  ;; GetLogicalDriveStringsA(nBufferLength, lpBuffer) — return "C:\\\0D:\\\0\0".
  ;; A Win98 installation normally exposes its fixed system disk and CD-ROM;
  ;; the CLI/reference harness mounts immutable fixture sets on D:.
  (func $handle_GetLogicalDriveStringsA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    (if (i32.lt_u (local.get $arg0) (i32.const 9))
      (then (global.set $eax (i32.const 9)))
      (else
        (local.set $buf (call $g2w (local.get $arg1)))
        (i32.store8 (local.get $buf) (i32.const 0x43))              ;; 'C'
        (i32.store8 (i32.add (local.get $buf) (i32.const 1)) (i32.const 0x3A))  ;; ':'
        (i32.store8 (i32.add (local.get $buf) (i32.const 2)) (i32.const 0x5C))  ;; '\\'
        (i32.store8 (i32.add (local.get $buf) (i32.const 3)) (i32.const 0))
        (i32.store8 (i32.add (local.get $buf) (i32.const 4)) (i32.const 0x44))  ;; 'D'
        (i32.store8 (i32.add (local.get $buf) (i32.const 5)) (i32.const 0x3A))  ;; ':'
        (i32.store8 (i32.add (local.get $buf) (i32.const 6)) (i32.const 0x5C))  ;; '\\'
        (i32.store8 (i32.add (local.get $buf) (i32.const 7)) (i32.const 0))
        (i32.store8 (i32.add (local.get $buf) (i32.const 8)) (i32.const 0))
        (global.set $eax (i32.const 8))))
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

  ;; CreateIconFromResourceEx(presbits, dwResSize, fIcon, dwVer, cx, cy, Flags) — 7 args.
  ;; Return a dummy non-zero HICON; SDL only uses it for SetClassLong/WM_SETICON which we ignore.
  (func $handle_CreateIconFromResourceEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0xCAFE0001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; LoadKeyboardLayoutA(pwszKLID, Flags) — pretend the requested layout was activated.
  (func $handle_LoadKeyboardLayoutA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x04090409))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; GetKeyboardLayoutNameA(pwszKLID) — write 9-byte ASCIIZ "00000409" (US English) and return TRUE.
  (func $handle_GetKeyboardLayoutNameA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32)
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (local.set $p (call $g2w (local.get $arg0)))
    (i32.store (local.get $p) (i32.const 0x30303030))         ;; "0000"
    (i32.store offset=4 (local.get $p) (i32.const 0x39303430)) ;; "0409"
    (i32.store8 offset=8 (local.get $p) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
    (global.set $eax (call $gdi_dc_aux_get (local.get $arg0) (i32.const 20) (i32.const 0)))
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

  ;; 490: GetDriveTypeA(lpRootPathName) — C: is fixed, D: is the CD-ROM.
  (func $handle_GetDriveTypeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $root i32)
    (global.set $eax (i32.const 3))  ;; DRIVE_FIXED / current C: drive
    (if (i32.ne (local.get $arg0) (i32.const 0))
      (then
        (local.set $root (call $g2w (local.get $arg0)))
        (if (i32.and
              (i32.eq (i32.and (i32.load8_u (local.get $root)) (i32.const 0xDF)) (i32.const 0x44))
              (i32.eq (i32.load8_u offset=1 (local.get $root)) (i32.const 0x3A)))
          (then (global.set $eax (i32.const 5))))))  ;; DRIVE_CDROM
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 491: GetCurrentProcessId — return this emulated process's stable PID
  (func $handle_GetCurrentProcessId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $current_process_id))
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

  ;; 496: GetDriveTypeW — Unicode counterpart of GetDriveTypeA.
  (func $handle_GetDriveTypeW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $root i32)
    (global.set $eax (i32.const 3))
    (if (i32.ne (local.get $arg0) (i32.const 0))
      (then
        (local.set $root (call $g2w (local.get $arg0)))
        (if (i32.and
              (i32.eq (i32.and (i32.load16_u (local.get $root)) (i32.const 0xDF)) (i32.const 0x44))
              (i32.eq (i32.load16_u offset=2 (local.get $root)) (i32.const 0x3A)))
          (then (global.set $eax (i32.const 5))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
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
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0)))) ;; exited with code 0
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) ;; stdcall, 2 args
  )

  ;; 499: CreateProcessA — STUB: unimplemented
  (func $handle_CreateProcessA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Process launch is out-of-scope for the in-browser emulator. Decline the
    ;; launch after installers have extracted their files; this avoids waiting
    ;; on a fake child process that will never really run.
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 44))) ;; stdcall, 10 args
  )

  ;; WinExec(lpCmdLine, uCmdShow) — legacy launcher. Pinball's Options →
  ;; Select Table uses this for table executables and only checks for >31.
  ;; The bundled build has a single in-process table, so report success.
  (func $handle_WinExec (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg0))
    (drop (local.get $arg1))
    (drop (local.get $name_ptr))
    (global.set $eax (i32.const 33))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 500: CreateProcessW — STUB: unimplemented
  (func $handle_CreateProcessW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 44)))
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
    (call $console_write (local.get $arg1) (local.get $arg2) (i32.const 0))
    (if (local.get $arg3)
      (then (i32.store (call $g2w (local.get $arg3)) (local.get $arg2))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 508: GetFileInformationByHandle(hFile, lpFileInformation) → BOOL
  ;; Populate the stable fields exposed by the in-memory VFS. Timestamps are
  ;; synthetic (as in GetFileTime), while file size and handle validity come
  ;; from the host so callers can distinguish real VFS files from bad handles.
  (func $handle_GetFileInformationByHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $info i32) (local $size i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $size (call $host_fs_get_file_size (local.get $arg0)))
    (if (i32.eq (local.get $size) (i32.const -1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $info (call $g2w (local.get $arg1)))
    (i32.store offset=0 (local.get $info) (i32.const 0x20))       ;; FILE_ATTRIBUTE_ARCHIVE
    (i32.store offset=4 (local.get $info) (i32.const 0x256D4000)) ;; creation FILETIME low
    (i32.store offset=8 (local.get $info) (i32.const 0x01BF53EB)) ;; creation FILETIME high
    (i32.store offset=12 (local.get $info) (i32.const 0x256D4000))
    (i32.store offset=16 (local.get $info) (i32.const 0x01BF53EB))
    (i32.store offset=20 (local.get $info) (i32.const 0x256D4000))
    (i32.store offset=24 (local.get $info) (i32.const 0x01BF53EB))
    (i32.store offset=28 (local.get $info) (i32.const 0x57415458)) ;; stable volume serial, "WATX"
    (i32.store offset=32 (local.get $info) (i32.const 0))         ;; file size high
    (i32.store offset=36 (local.get $info) (local.get $size))
    (i32.store offset=40 (local.get $info) (i32.const 1))         ;; link count
    (i32.store offset=44 (local.get $info) (i32.const 0))
    (i32.store offset=48 (local.get $info) (local.get $arg0))     ;; stable per-open file index
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; 517: FormatMessageW(dwFlags, lpSource, dwMessageId, dwLanguageId, lpBuffer, nSize, Arguments)
  ;; The same call as FormatMessageA with UTF-16 on both ends: the template is
  ;; narrowed on the way in, the finished text widened on the way out, and
  ;; nSize counts WCHARs rather than bytes. The decisions in between belong to
  ;; $format_message_ansi, which is the only implementation either spelling has.
  (func $handle_FormatMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $nSize i32) (local $args_g i32) (local $len i32) (local $fmt_ga i32)
    (local $fmt_wa i32) (local $tmp_ga i32) (local $dst i32) (local $buf_ga i32)
    (local.set $nSize (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $args_g (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (if (i32.and (local.get $arg0) (i32.const 0x200))
      (then (local.set $args_g (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
    (if (i32.and (local.get $arg0) (i32.const 0x400))
      (then
        (if (i32.eqz (local.get $arg1))
          (then (global.set $eax (i32.const 0)) (return)))
        (local.set $fmt_ga (call $heap_alloc
          (i32.add (call $guest_wcslen (local.get $arg1)) (i32.const 1))))
        (if (i32.eqz (local.get $fmt_ga))
          (then (global.set $eax (i32.const 0)) (return)))
        (drop (call $wide_to_ansi (local.get $arg1) (local.get $fmt_ga)
          (i32.add (call $guest_wcslen (local.get $arg1)) (i32.const 1))))
        (local.set $fmt_wa (call $g2w (local.get $fmt_ga)))))
    (local.set $len (call $format_message_ansi (local.get $arg0) (local.get $fmt_wa)
      (local.get $arg1) (local.get $arg2) (local.get $args_g) (i32.const 0) (i32.const 0)))
    ;; Expanded once more into an ANSI staging buffer and widened from there:
    ;; the caller's buffer is UTF-16, which $format_message_ansi cannot write.
    (local.set $tmp_ga (call $heap_alloc (i32.add (local.get $len) (i32.const 1))))
    (if (local.get $tmp_ga)
      (then
        (drop (call $format_message_ansi (local.get $arg0) (local.get $fmt_wa)
          (local.get $arg1) (local.get $arg2) (local.get $args_g)
          (call $g2w (local.get $tmp_ga)) (i32.add (local.get $len) (i32.const 1))))
        (if (i32.and (local.get $arg0) (i32.const 0x100))
          (then
            (local.set $buf_ga (call $heap_alloc
              (i32.shl (i32.add (local.get $len) (i32.const 1)) (i32.const 1))))
            (i32.store (call $g2w (local.get $arg4)) (local.get $buf_ga))
            (local.set $dst (local.get $buf_ga))
            (local.set $nSize (i32.add (local.get $len) (i32.const 1))))
          (else
            (local.set $dst (local.get $arg4))))
        (if (i32.and (i32.ne (local.get $dst) (i32.const 0))
                     (i32.ne (local.get $nSize) (i32.const 0)))
          (then (drop (call $ansi_to_wide
            (local.get $tmp_ga) (local.get $dst) (local.get $nSize)))))
        (call $heap_free (local.get $tmp_ga))))
    (if (local.get $fmt_ga) (then (call $heap_free (local.get $fmt_ga))))
    (global.set $eax (local.get $len))
  )

  ;; 518: GetFileSize — STUB: unimplemented
  (func $handle_GetFileSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetFileSize(hFile, lpFileSizeHigh) — 2 args
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (call $host_fs_get_file_size (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 519: GetFileTime(hFile, lpCreationTime, lpLastAccessTime, lpLastWriteTime)
  ;; Minimal VFS timestamp surface. The current virtual FS does not persist
  ;; per-file mtimes, but MFC document save paths require this API to succeed
  ;; after CreateFileA. Return a stable FILETIME near the simulated clock.
  (func $handle_GetFileTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $lo i32) (local $hi i32)
    ;; Base: 2000-01-01 = 0x01BF53EB256D4000, add ticks*10000 (100ns units).
    (local.set $lo
      (i32.add (i32.const 0x256D4000) (i32.mul (call $host_get_ticks) (i32.const 10000))))
    (local.set $hi (i32.const 0x01BF53EB))
    (if (local.get $arg1)
      (then
        (call $gs32 (local.get $arg1) (local.get $lo))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (local.get $hi))))
    (if (local.get $arg2)
      (then
        (call $gs32 (local.get $arg2) (local.get $lo))
        (call $gs32 (i32.add (local.get $arg2) (i32.const 4)) (local.get $hi))))
    (if (local.get $arg3)
      (then
        (call $gs32 (local.get $arg3) (local.get $lo))
        (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (local.get $hi))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; GetStringTypeExA(Locale, dwInfoType, lpSrcStr, cchSrc, lpCharType)
  (func $handle_GetStringTypeExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $get_string_type_a_core (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 520: GetStringTypeExW(Locale, dwInfoType, lpSrcStr, cchSrc, lpCharType)
  (func $handle_GetStringTypeExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $get_string_type_w_core (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 521: GetThreadLocale() → LCID — returns US English
  (func $handle_GetThreadLocale (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x0409))  ;; MAKELCID(LANG_ENGLISH, SUBLANG_ENGLISH_US)
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 522: CreateSemaphoreW(lpAttr, lInit, lMax, lpName) → real counted semaphore via host.
  (func $handle_CreateSemaphoreW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_create_semaphore (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 523: ReleaseSemaphore(hSem, lReleaseCount, lpPrevCount) → host increments and writes back prior count.
  (func $handle_ReleaseSemaphore (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_release_semaphore
      (local.get $arg0)
      (local.get $arg1)
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 524: CreateMutexW(lpMutexAttributes, bInitialOwner, lpName) → HANDLE
  ;; Returns a unique handle for the mutex. Single-threaded, so always succeeds.
  (func $handle_CreateMutexW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $eax (global.get $next_hwnd))
    (global.set $last_error (i32.const 0))
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
    (global.set $last_error (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; CreateSemaphoreA(lpAttr, lInit, lMax, lpName) → real counted semaphore via host.
  (func $handle_CreateSemaphoreA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_create_semaphore (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; OpenSemaphoreA(dwDesiredAccess, bInheritHandle, lpName). Named kernel
  ;; objects are process-local in the current host model, so a new emulator
  ;; process has no pre-existing semaphore to open. Return the documented
  ;; not-found result; callers such as DX-Ball then create their instance
  ;; semaphore through CreateSemaphoreA.
  (func $handle_OpenSemaphoreA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $last_error (i32.const 2)) ;; ERROR_FILE_NOT_FOUND
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
        (global.set $wait_timeout (local.get $arg3))
        (global.set $wait_stack_bytes (i32.const 20))
        (global.set $steps (i32.const 0))
        (return)))
    (global.set $eax (local.get $result))
    (call $host_log_i32 (global.get $eax))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 528: GlobalAddAtomW(lpString) — 1 arg stdcall, shares the A namespace.
  (func $handle_GlobalAddAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $narrow i32)
    (local.set $narrow (call $atom_narrow_w (local.get $arg0)))
    (global.set $eax (call $atom_add (global.get $ATOM_GLOBAL_TABLE) (local.get $narrow)))
    (call $atom_narrow_free (local.get $arg0) (local.get $narrow))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 529: FindResourceW — same as FindResourceA (resource IDs are integer MAKEINTRESOURCE values)
  (func $handle_FindResourceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax (call $find_resource (local.get $arg2) (local.get $arg1)))
    (call $pop_rsrc_ctx)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 530: GlobalGetAtomNameW(nAtom, lpBuffer, nSize)
  (func $handle_GlobalGetAtomNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_get_name_w (global.get $ATOM_GLOBAL_TABLE)
      (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 531: GetProfileIntW(appName, keyName, nDefault) — Unicode win.ini read
  (func $handle_GetProfileIntW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_ini_get_int
      (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2)
      (global.get $win_ini_name_ptr)
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; GetProfileStringW(appName, keyName, default, retBuf, nSize) — Unicode win.ini read
  (func $handle_GetProfileStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_ini_get_string
      (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)
      (local.get $arg4)
      (global.get $win_ini_name_ptr)
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 532: VirtualProtect — STUB: unimplemented
  (func $handle_VirtualProtect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; VirtualQuery(lpAddress, lpBuffer, dwLength) → SIZE_T
  ;; Pretend the entire 4GB address space is one committed RW region rooted at
  ;; image_base. Apps that probe a ptr (e.g. CRT exception filter, MFC heap walker)
  ;; just want a non-zero return + plausible State/Protect, not real bookkeeping.
  ;; MEMORY_BASIC_INFORMATION layout (28 bytes):
  ;;   +0  BaseAddress     PVOID
  ;;   +4  AllocationBase  PVOID
  ;;   +8  AllocationProtect DWORD  (PAGE_READWRITE = 0x04)
  ;;   +12 RegionSize      SIZE_T
  ;;   +16 State           DWORD   (MEM_COMMIT = 0x1000)
  ;;   +20 Protect         DWORD   (PAGE_READWRITE = 0x04)
  ;;   +24 Type            DWORD   (MEM_PRIVATE = 0x20000)
  (func $handle_VirtualQuery (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32)
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
            (return)))
    (if (i32.lt_u (local.get $arg2) (i32.const 28))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
            (return)))
    (local.set $buf (call $g2w (local.get $arg1)))
    (i32.store (local.get $buf)                            (i32.and (local.get $arg0) (i32.const 0xFFFFF000)))
    (i32.store (i32.add (local.get $buf) (i32.const 4))    (global.get $image_base))
    (i32.store (i32.add (local.get $buf) (i32.const 8))    (i32.const 0x04))      ;; AllocationProtect = PAGE_READWRITE
    (i32.store (i32.add (local.get $buf) (i32.const 12))   (i32.const 0x10000000));; RegionSize = 256MB (huge)
    (i32.store (i32.add (local.get $buf) (i32.const 16))   (i32.const 0x1000))    ;; State = MEM_COMMIT
    (i32.store (i32.add (local.get $buf) (i32.const 20))   (i32.const 0x04))      ;; Protect = PAGE_READWRITE
    (i32.store (i32.add (local.get $buf) (i32.const 24))   (i32.const 0x20000))   ;; Type = MEM_PRIVATE
    (global.set $eax (i32.const 28))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetDeviceGammaRamp(hdc, lpRamp) — retrieve WAT-owned display LUT state.
  (func $handle_GetDeviceGammaRamp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_gamma_ramp_get (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 533: FindResourceExW(hModule, lpType, lpName, wLanguage) → HRSRC
  ;; The resource walker addresses types and names by ordinal and matches
  ;; string names as ASCII, which is exactly what FindResourceW already does
  ;; with the same pointers — the Ex form only adds a language we ignore.
  (func $handle_FindResourceExW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_FindResourceExA (local.get $arg0) (local.get $arg1)
      (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 534: SizeofResource(hModule, hResInfo) — return size from resource data entry
  (func $handle_SizeofResource (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; hResInfo (arg1) is relative to hModule (same as FindResource return).
    ;; Data entry: [RVA:4][Size:4][CodePage:4][Reserved:4]
    (if (i32.eqz (local.get $arg1))
      (then (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax
      (call $gl32
        (i32.add (call $r_base)
          (i32.add (local.get $arg1) (i32.const 4)))))
    (call $pop_rsrc_ctx)
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

  ;; 536: GlobalFlags(hMem) → flags/lock count.
  ;; Our GlobalAlloc returns a direct heap pointer and GlobalLock is identity,
  ;; so there is no movable/discardable/lock-count state to report. Return 0,
  ;; which is the normal unlocked/fixed-memory result.
  (func $handle_GlobalFlags (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 537: GetDiskFreeSpaceW(lpRootPathName, ...) — every value this call
  ;; returns is a number written through a caller pointer, and the one string
  ;; it takes names a drive we answer the same way for either encoding, so
  ;; the A implementation is the whole implementation.
  (func $handle_GetDiskFreeSpaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_GetDiskFreeSpaceA (local.get $arg0) (local.get $arg1)
      (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 538: SearchPathW(lpPath, lpFileName, lpExtension, nBufferLength,
  ;;                  lpBuffer, lpFilePart) → chars written
  ;; The host search takes an isWide flag and does the conversion on both
  ;; sides of itself, so this is SearchPathA with that flag set.
  (func $handle_SearchPathW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (global.set $eax (call $host_fs_search_path
      (if (result i32) (local.get $arg0) (then (call $g2w (local.get $arg0))) (else (i32.const 0)))
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)        ;; bufLen
      (local.get $arg4)        ;; bufGA (guest addr, host g2w's)
      (i32.load (i32.add (local.get $wa_esp) (i32.const 24)))  ;; lpFilePart
      (i32.const 1)))          ;; isWide=1
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))  ;; stdcall, 6 args
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

  ;; SuspendThread(hThread) — 1 arg stdcall, return previous suspend count (0 = not suspended)
  (func $handle_SuspendThread (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_suspend_thread (local.get $arg0)))
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

  ;; 546: GetVolumeInformationW — the same volume GetVolumeInformationA
  ;; describes, with its two strings written as UTF-16.
  (func $handle_GetVolumeInformationW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $volume_information
      (local.get $arg1) (local.get $arg3) (local.get $arg4) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))) ;; stdcall 8 args
  )

  ;; 782: GetVolumeInformationA — 8 args stdcall, return TRUE with fake data
  ;; The volume this emulator presents, filled into the caller's out
  ;; parameters. Both spellings describe the same volume and differ only in
  ;; how the two strings are written, so $wide decides that and nothing else.
  ;; The three arguments past arg4 are read off the guest stack here, before
  ;; either entry point pops it.
  (func $volume_information (param $name_buf i32) (param $serial i32)
                            (param $max_comp i32) (param $wide i32) (result i32)
    (local $wa_esp i32) (local $fs_flags i32) (local $fs_name i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $fs_flags (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (local.set $fs_name (i32.load (i32.add (local.get $wa_esp) (i32.const 28))))
    ;; The volume has no label: an empty string, in the caller's encoding.
    (if (local.get $name_buf)
      (then
        (if (local.get $wide)
          (then (i32.store16 (call $g2w (local.get $name_buf)) (i32.const 0)))
          (else (i32.store8 (call $g2w (local.get $name_buf)) (i32.const 0))))))
    (if (local.get $serial)
      (then (call $gs32 (local.get $serial) (i32.const 0x12345678))))
    (if (local.get $max_comp)
      (then (call $gs32 (local.get $max_comp) (i32.const 255))))
    ;; FILE_CASE_PRESERVED_NAMES | FILE_CASE_SENSITIVE_SEARCH
    (if (local.get $fs_flags)
      (then (call $gs32 (local.get $fs_flags) (i32.const 0x00000003))))
    (if (local.get $fs_name)
      (then
        (if (local.get $wide)
          (then
            (i32.store16 (call $g2w (local.get $fs_name)) (i32.const 0x46))          ;; 'F'
            (i32.store16 offset=2 (call $g2w (local.get $fs_name)) (i32.const 0x41)) ;; 'A'
            (i32.store16 offset=4 (call $g2w (local.get $fs_name)) (i32.const 0x54)) ;; 'T'
            (i32.store16 offset=6 (call $g2w (local.get $fs_name)) (i32.const 0)))
          (else
            (i32.store (call $g2w (local.get $fs_name)) (i32.const 0x00544146))))))  ;; "FAT"
    (i32.const 1))

  (func $handle_GetVolumeInformationA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $volume_information
      (local.get $arg1) (local.get $arg3) (local.get $arg4) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))) ;; stdcall 8 args
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

  ;; 550: GlobalDeleteAtom(nAtom) — release one global reference; 0 = success.
  (func $handle_GlobalDeleteAtom (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_delete (global.get $ATOM_GLOBAL_TABLE) (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; FindAtomA/W(lpString) — process-local lookup; 0 when never added.
  (func $handle_FindAtomA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $atom_find (global.get $ATOM_LOCAL_TABLE) (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_FindAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $narrow i32)
    (local.set $narrow (call $atom_narrow_w (local.get $arg0)))
    (global.set $eax (call $atom_find (global.get $ATOM_LOCAL_TABLE) (local.get $narrow)))
    (call $atom_narrow_free (local.get $arg0) (local.get $narrow))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 551: GlobalFindAtomW(lpString) — global lookup; 0 when never added.
  (func $handle_GlobalFindAtomW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $narrow i32)
    (local.set $narrow (call $atom_narrow_w (local.get $arg0)))
    (global.set $eax (call $atom_find (global.get $ATOM_GLOBAL_TABLE) (local.get $narrow)))
    (call $atom_narrow_free (local.get $arg0) (local.get $narrow))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  (func $handle_CopyMetaFileA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_copy (local.get $arg0) (i32.const 6)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_CopyMetaFileW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_copy (local.get $arg0) (i32.const 6)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 146: ExtCreatePen(style, width, LOGBRUSH*, styleCount, styleEntries).
  (func $handle_ExtCreatePen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $brush i32) (local $style i32) (local $color i32) (local $flags i32)
    (if (i32.eqz (local.get $arg2))
      (then (global.set $eax (i32.const 0)))
      (else
        (local.set $brush (call $g2w (local.get $arg2)))
        (local.set $style (i32.and (local.get $arg0) (i32.const 0xF)))
        (local.set $color (i32.load offset=4 (local.get $brush)))
        (local.set $flags (i32.or
          (select (i32.const 1) (i32.const 0) (i32.eq (local.get $style) (i32.const 5)))
          (i32.and (local.get $arg0) (i32.const 0x000F0F00))))
        (global.set $eax (call $gdi_object_alloc (i32.const 1)
          (local.get $style) (local.get $arg1) (local.get $color) (local.get $flags)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 561: EnumMetaFile — validate and enumerate each classic WMF record through
  ;; the guest MFENUMPROC. The WAT callback context owns the HANDLETABLE.
  (func $handle_EnumMetaFile (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (call $gdi_metafile_enum_start (local.get $arg0) (local.get $arg1)
      (local.get $arg2) (local.get $arg3) (local.get $ret) (global.get $esp))
  )

;; 563: PlayMetaFileRecord — replay one validated WMF record against the
  ;; caller's live HANDLETABLE, preserving object/state changes for the next
  ;; EnumMetaFile callback.
  (func $handle_PlayMetaFileRecord (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_metafile_play_wmf_record
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

SetColorAdjustment — validate and copy complete per-DC state.
  (func $handle_SetColorAdjustment (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_color_adjustment_set
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_GetColorAdjustment (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_color_adjustment_get
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

;; 571: PolyDraw — WAT-owned PT_MOVETO/PT_LINETO/PT_BEZIERTO path execution.
  (func $handle_PolyDraw (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $gdi_dc_path_is_open (local.get $arg0))
      (then (global.set $eax (call $gdi_dc_path_record_polydraw (local.get $arg0)
        (call $g2w (local.get $arg1)) (call $g2w (local.get $arg2)) (local.get $arg3))))
      (else (global.set $eax (call $gdi_poly_draw (local.get $arg0)
        (call $g2w (local.get $arg1)) (call $g2w (local.get $arg2)) (local.get $arg3)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

 574: SetMapperFlags — per-DC font mapper flags.
  (func $handle_SetMapperFlags (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_dc_aux_set
      (local.get $arg0) (i32.const 16) (local.get $arg1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $handle_StartDocW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.or
          (i32.ne (local.get $arg0) (global.get $printer_hdc))
          (i32.ne (global.get $printer_doc_state) (i32.const 0)))
      (then (global.set $eax (i32.const -1)))
      (else
        (global.set $printer_doc_state (i32.const 1))
        (global.set $printer_page_count (i32.const 0))
        (global.set $eax (i32.const 1))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 603: GetCharWidthW(hdc, first, last, widths) — UTF-16 range width query.
  (func $handle_GetCharWidthW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_font_char_widths
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 606: GetTextFaceW(hdc, cch, face) — UTF-16 variant of GetTextFaceA.
  (func $handle_GetTextFaceW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_font_write_text_face
      (local.get $arg0) (local.get $arg1)
      (if (result i32) (local.get $arg2)
        (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 607: MsgWaitForMultipleObjects(nCount, pHandles, fWaitAll, dwMilliseconds, dwWakeMask) → DWORD
  ;; 5 args stdcall = 24 bytes. Returns WAIT_OBJECT_0+i for signaled handle, or nCount for messages.
  (func $handle_MsgWaitForMultipleObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $result i32) (local $packed i32)
    ;; Check if messages are pending first (post queue, paint, timers, host input).
    ;; host_check_input is destructive, so cache the event for the next
    ;; GetMessage/PeekMessage call instead of using it as a throwaway probe.
    (if (i32.eqz (global.get $pending_input_packed))
      (then
        (local.set $packed (call $host_check_input))
        (if (i32.ne (local.get $packed) (i32.const 0))
          (then
            (global.set $pending_input_packed (local.get $packed))
            (global.set $pending_input_hwnd (call $host_check_input_hwnd))
            (global.set $pending_input_lparam (call $host_check_input_lparam))))))
    (if (i32.or
          (i32.or
            (i32.or (global.get $quit_flag)
                    (i32.gt_u (global.get $post_queue_count) (i32.const 0)))
            (i32.or (i32.gt_u (i32.load (i32.const 0xB400)) (i32.const 0))
                    (global.get $pending_input_packed)))
          (i32.or
            (i32.or (global.get $paint_pending)
                    (global.get $nc_flags_count))
            (i32.or (call $paint_flag_any)
                    (call $timer_check_due (global.get $PAINT_SCRATCH) (i32.const 0)))))
      (then
        ;; Message available: return WAIT_OBJECT_0 + nCount
        (global.set $eax (local.get $arg0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; Private message pumps use the handle only as another wake source. Polling
    ;; it here would consume auto-reset events before the worker can observe
    ;; them, so let the worker scheduler progress and retry on the next slice.
    ;; Nothing ready — if timeout is 0, return WAIT_TIMEOUT
    (if (i32.eqz (local.get $arg3))
      (then
        (global.set $eax (i32.const 0x102))  ;; WAIT_TIMEOUT
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; Message-aware waits are commonly embedded in private PeekMessage loops.
    ;; Complete the stdcall frame before yielding the emulator slice so host
    ;; input cannot synchronously re-enter guest code with this frame live.
    (global.set $eax (i32.const 0x102)) ;; WAIT_TIMEOUT
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (global.set $yield_flag (i32.const 1))
    (global.set $steps (i32.const 0)))

  ;; 608: GetWindowPlacement(hWnd, lpwndpl) — 2 args stdcall
  ;; WINDOWPLACEMENT's normal rect describes the requested window, not the
  ;; desktop. MFC uses this for child layout too (Font Viewer sizes its sample
  ;; pane from dialog-control placements), so a fixed 640x480 rect produces
  ;; negative child dimensions.
  (func $handle_GetWindowPlacement (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $x i32) (local $y i32)
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
    ;; rcNormalPosition = current window rectangle. Child placement uses
    ;; parent-client coordinates; top-level placement uses screen coordinates.
    ;;
    ;; Both operands are coerced to 0/1 first. `i32.and` is bitwise, and
    ;; WS_CHILD (0x40000000) shares no bit with a real hwnd like 0x10001, so
    ;; ANDing them raw is always 0 - every child then reported screen
    ;; coordinates. An app that reads one control's placement and lays its
    ;; siblings out against it moves them by the parent's whole non-client
    ;; offset: fontview.exe reads Done at y=31 instead of y=8 and drops its
    ;; other three buttons a row lower than the row Win98 puts them in.
    (if (i32.and
          (i32.ne
            (i32.and (call $wnd_get_style (local.get $arg0)) (i32.const 0x40000000))
            (i32.const 0))
          (i32.ne (call $wnd_get_parent (local.get $arg0)) (i32.const 0)))
      (then
        (local.set $x (call $ctrl_get_x_s (local.get $arg0)))
        (local.set $y (call $ctrl_get_y_s (local.get $arg0)))
        (i32.store offset=28 (local.get $wa) (local.get $x))
        (i32.store offset=32 (local.get $wa) (local.get $y))
        (i32.store offset=36 (local.get $wa)
          (i32.add (local.get $x) (call $wnd_screen_w (local.get $arg0))))
        (i32.store offset=40 (local.get $wa)
          (i32.add (local.get $y) (call $wnd_screen_h (local.get $arg0)))))
      (else
        (call $host_get_window_rect (local.get $arg0)
          (i32.add (local.get $wa) (i32.const 28)))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; stdcall, 2 args
  )

  ;; 609: RegisterWindowMessageW(lpString) — the A spelling's message, by name.
  ;; It used to mint its own number, so an app that registered a message as W
  ;; and received it from a component that registered it as A never matched.
  (func $handle_RegisterWindowMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ansi i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0)) (return)))
    (local.set $ansi (call $clipfmt_wide_to_ansi (local.get $arg0)))
    (if (i32.eqz (local.get $ansi))
      (then (global.set $eax (i32.const 0)) (return)))
    (global.set $eax (call $register_window_message (local.get $ansi)))
    (call $heap_free (local.get $ansi))
  )

  ;; 610: GetForegroundWindow — STUB: unimplemented
  (func $handle_GetForegroundWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; GetForegroundWindow() — 0 args, return active window handle
    (global.set $eax (global.get $main_hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 611: GetMessagePos — returns the screen-space cursor position
  ;; (y<<16 | x) at the time of the last retrieved message.
  (func $handle_GetMessagePos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (i32.or
        (i32.and (global.get $last_msg_pos_x) (i32.const 0xFFFF))
        (i32.shl
          (i32.and (global.get $last_msg_pos_y) (i32.const 0xFFFF))
          (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 612: GetMessageTime — return tick count of the last message retrieved via
  ;; GetMessage/PeekMessage.
  (func $handle_GetMessageTime (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (global.get $last_msg_time))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
  )

  ;; 613: RemovePropW(hwnd, lpString) -> HANDLE.
  ;; Share the lightweight USER32 property table with the A variant; atom names
  ;; already pass through unchanged, and app-local string properties only need a
  ;; stable key across Set/Get/Remove.
  (func $handle_RemovePropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_RemovePropA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 614: CallWindowProcW — same ABI as CallWindowProcA
  (func $handle_CallWindowProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_CallWindowProcA
      (local.get $arg0)
      (local.get $arg1)
      (local.get $arg2)
      (local.get $arg3)
      (local.get $arg4)
      (local.get $name_ptr))
  )

  ;; 793: CallWindowProcA — call a WndProc with (hwnd, msg, wParam, lParam)
  ;; Stack on entry: [ret][lpPrevWndFunc][hWnd][Msg][wParam][lParam]
  ;; We set up a call frame to the WndProc so it returns to our caller.
  (func $handle_CallWindowProcA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32) (local $ctrl_class i32) (local $thunk_idx i32) (local $thunk_api i32)
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
    ;; A system class marker handed out by GetClassInfo. The app subclassed one
    ;; of USER's controls and is chaining back to it for default handling, so
    ;; this is where the control actually gets drawn and where it learns about
    ;; clicks. Unlike $WNDPROC_BUILTIN below, WM_PAINT belongs here: nothing
    ;; else in the system knows this window is a button.
    ;;
    ;; The window was created under the app's own class name, so it is not in
    ;; the control table yet. Adopt it on the first chained call — the app has
    ;; just told us what it started life as, which is the only evidence we get.
    (if (i32.eq (i32.and (local.get $arg0) (i32.const 0xFFFFFF00))
                (global.get $WNDPROC_SYSCLASS))
      (then
        (local.set $ctrl_class (i32.and (local.get $arg0) (i32.const 0xFF)))
        (if (i32.eqz (call $ctrl_table_get_class (local.get $arg1)))
          (then
            (local.set $thunk_idx (call $wnd_table_find (local.get $arg1)))
            (if (i32.ne (local.get $thunk_idx) (i32.const -1))
              (then
                (call $ctrl_table_set (local.get $thunk_idx)
                  (local.get $ctrl_class)
                  (call $ctrl_table_get_id (local.get $arg1)))
                (call $sysclass_replay_create (local.get $arg1) (local.get $thunk_idx))))))
        (global.set $eax (call $control_wndproc_dispatch
          (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; Sentinel 0xFFFE0001 = built-in control default wndproc.
    ;; Subclassed WAT controls chain here for stateful control messages such as
    ;; BM_SETIMAGE; deliver those to the native control proc instead of dropping
    ;; them as DefWindowProc.
    (if (i32.eq (local.get $arg0) (global.get $WNDPROC_BUILTIN))
      (then
        (local.set $ctrl_class (call $ctrl_table_get_class (local.get $arg1)))
        (if (i32.and (i32.ne (local.get $ctrl_class) (i32.const 0))
                     (i32.ne (local.get $arg2) (i32.const 0x000F)))
          (then
            (global.set $eax (call $control_wndproc_dispatch
              (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4))))
          (else
            (global.set $eax (i32.const 0))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; DefDlgProc marker returned by GWL_WNDPROC before a dialog is
    ;; subclassed. Execute the per-window DLGPROC and honor DWL_MSGRESULT.
    (if (i32.eq (local.get $arg0) (global.get $WNDPROC_DIALOG))
      (then
        (global.set $eax (call $dialog_default_proc
          (local.get $arg1) (local.get $arg2)
          (local.get $arg3) (local.get $arg4)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; WAT-native wndprocs (for current controls, 0xFFFF0002) are markers,
    ;; not guest-code addresses. Dispatch them directly instead of jumping.
    (if (i32.ge_u (local.get $arg0) (i32.const 0xFFFF0000))
      (then
        ;; Some subclass procs chain WM_PAINT only to let the native control
        ;; render. Our renderer paints WAT-native controls out of band, and
        ;; avoiding this chain keeps NSIS treeview paint from re-entering while
        ;; its dialog procedure is unwinding.
        (if (i32.eq (local.get $arg2) (i32.const 0x000F))
          (then
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
            (return)))
        (if (i32.eq (local.get $arg0) (global.get $WNDPROC_CTRL_NATIVE))
          (then
            (global.set $eax (call $control_wndproc_dispatch
              (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4))))
          (else
            (global.set $eax (call $wat_wndproc_dispatch
              (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; DefWindowProc import thunks are common saved "previous wndprocs" for
    ;; MFC subclasses. Dispatch them directly instead of recursively entering
    ;; the generic thunk path from inside CallWindowProc*.
    (if (i32.and (i32.ge_u (local.get $arg0) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $arg0) (global.get $thunk_guest_end)))
      (then
        (local.set $thunk_idx
          (i32.div_u (i32.sub (local.get $arg0) (global.get $thunk_guest_base)) (i32.const 8)))
        (local.set $thunk_api
          (i32.load (i32.add
            (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8)))
            (i32.const 4))))
        (if (i32.or (i32.eq (local.get $thunk_api) (i32.const 98))
                    (i32.eq (local.get $thunk_api) (i32.const 99)))
          (then
            ;; Skip lpPrevWndFunc; DefWindowProc's own stdcall cleanup then
            ;; consumes ret+hWnd+Msg+wParam+lParam = the full CallWindowProc
            ;; frame size.
            (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
            (if (i32.eq (local.get $thunk_api) (i32.const 98))
              (then
                (call $handle_DefWindowProcA
                  (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
                  (i32.const 0) (local.get $name_ptr)))
              (else
                (call $handle_DefWindowProcW
                  (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
                  (i32.const 0) (local.get $name_ptr))))
            (return)))))
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
    (local $old_cs i32) (local $new_cs i32) (local $flags i32)
    ;; Apply position immediately (no batching needed)
    ;; arg0=hDWP, arg1=hWnd, arg2=hInsertAfter, arg3=x, arg4=y, cx=stack[24], cy=stack[28], uFlags=stack[32]
    (local.set $old_cs (call $host_get_window_client_size (local.get $arg1)))
    (local.set $flags (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
    (call $host_move_window (local.get $arg1) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (local.get $flags))
    (call $ctrl_geom_sync (local.get $arg1) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (local.get $flags))
    ;; Keep the WAT window style synchronized with the host visibility, just
    ;; as SetWindowPos and ShowWindow do. MFC hides dock bars with deferred
    ;; SWP_HIDEWINDOW calls during Print Preview, then consults GWL_STYLE when
    ;; restoring the layout. A stale WS_VISIBLE makes it omit SWP_SHOWWINDOW.
    (if (i32.ne
          (i32.and (local.get $flags) (i32.const 0x0040)) ;; SWP_SHOWWINDOW
          (i32.const 0))
      (then
        (drop (call $wnd_set_style (local.get $arg1)
          (i32.or (call $wnd_get_style (local.get $arg1)) (i32.const 0x10000000))))))
    (if (i32.ne
          (i32.and (local.get $flags) (i32.const 0x0080)) ;; SWP_HIDEWINDOW
          (i32.const 0))
      (then
        (drop (call $wnd_set_style (local.get $arg1)
          (i32.and (call $wnd_get_style (local.get $arg1)) (i32.const 0xEFFFFFFF))))
        (call $paint_clear_subtree (local.get $arg1))))
    ;; Refresh CLIENT_RECT now (MFC's AfxWndProc may not forward NCCALCSIZE to
    ;; DefWindowProc, so queuing the message alone doesn't update our table),
    ;; and queue a paint so the moved child redraws.
    (call $defwndproc_do_nccalcsize (local.get $arg1))
    (call $host_sync_window_client
      (local.get $arg1)
      (call $wnd_client_screen_x (local.get $arg1))
      (call $wnd_client_screen_y (local.get $arg1))
      (i32.sub (call $client_rect_get_r (local.get $arg1)) (call $client_rect_get_l (local.get $arg1)))
      (i32.sub (call $client_rect_get_b (local.get $arg1)) (call $client_rect_get_t (local.get $arg1))))
    (local.set $new_cs (call $host_get_window_client_size (local.get $arg1)))
    (if (i32.and
          (i32.eqz (i32.and (local.get $flags) (i32.const 1))) ;; !SWP_NOSIZE
          (i32.ne (local.get $new_cs) (local.get $old_cs)))
      (then
        (drop (call $post_queue_push
          (local.get $arg1) (i32.const 0x0005) (i32.const 0) (local.get $new_cs)))))
    ;; Hidden windows have no update region, and SWP_NOREDRAW must not create
    ;; one. Queue/dispatch paint only for an effectively visible target.
    (if (i32.and
          (i32.eqz (i32.and (local.get $flags) (i32.const 0x0008))) ;; !SWP_NOREDRAW
          (call $wnd_is_effectively_visible (local.get $arg1)))
      (then (call $paint_flag_set_inv (local.get $arg1))))
    (if (i32.and
          (i32.and
            (i32.ne (call $ctrl_table_get_class (local.get $arg1)) (i32.const 0))
            (call $wnd_is_effectively_visible (local.get $arg1)))
          (i32.eqz (i32.and (local.get $flags) (i32.const 0x0008))))
      (then
        (drop (call $control_wndproc_dispatch
          (local.get $arg1) (i32.const 0x000F) (i32.const 0) (i32.const 0)))))
    (global.set $eax (local.get $arg0))  ;; return same HDWP handle
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))  ;; stdcall, 8 args
  )

  ;; 631: EndDeferWindowPos(hWinPosInfo) → BOOL
  (func $handle_EndDeferWindowPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))  ;; TRUE
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 615: GetPropW(hwnd, lpString) -> HANDLE
  (func $handle_GetPropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_GetPropA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 616: SetPropW(hwnd, lpString, hData) -> BOOL
  (func $handle_SetPropW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_SetPropA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 617: GetWindowTextLengthW(hwnd) → length in characters. A title's length
  ;; in characters does not depend on the encoding it is asked for, and the
  ;; conversion on either side of this emulator is one byte per character, so
  ;; this is the A answer exactly.
  (func $handle_GetWindowTextLengthW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_GetWindowTextLengthA (local.get $arg0) (local.get $arg1)
      (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
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

GetTopWindow(hWnd) — 1 arg stdcall
  (func $handle_GetTopWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wnd_find_first_child (local.get $arg0)))
    (if (i32.eqz (global.get $eax))
      (then (global.set $eax (call $host_get_window_related (local.get $arg0) (i32.const 5)))))
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
    (local $slot i32) (local $base i32) (local $aux i32) (local $lpsi i32) (local $fMask i32)
    (local $smin i32) (local $smax i32) (local $page i32) (local $pos i32) (local $max_pos i32)
    (local $style i32) (local $new_style i32) (local $bar_bit i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (local.set $lpsi (call $g2w (local.get $arg2)))
    (local.set $fMask (i32.load offset=4 (local.get $lpsi)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        (local.set $aux (i32.add (global.get $SCROLL_AUX_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 16))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 8)))))
        ;; SIF_RANGE = 0x01
        (if (i32.and (local.get $fMask) (i32.const 1))
          (then
            (i32.store offset=4 (local.get $base) (i32.load offset=8 (local.get $lpsi)))
            (i32.store offset=8 (local.get $base) (i32.load offset=12 (local.get $lpsi)))))
        ;; SIF_PAGE = 0x02
        (if (i32.and (local.get $fMask) (i32.const 2))
          (then
            (i32.store (local.get $aux) (i32.load offset=16 (local.get $lpsi)))))
        ;; SIF_POS = 0x04
        (if (i32.and (local.get $fMask) (i32.const 4))
          (then
            (i32.store (local.get $base) (i32.load offset=20 (local.get $lpsi)))))
        ;; SIF_TRACKPOS = 0x10. Real SetScrollInfo does not make the thumb
        ;; position from nTrackPos, but preserving it lets later GetScrollInfo
        ;; calls see coherent state.
        (if (i32.and (local.get $fMask) (i32.const 16))
          (then
            (i32.store offset=4 (local.get $aux) (i32.load offset=24 (local.get $lpsi)))))
        ;; Clamp the stored position to the Win32 scrollbar range. With a page
        ;; size, the largest useful position is nMax - max(nPage - 1, 0).
        (local.set $smin (i32.load offset=4 (local.get $base)))
        (local.set $smax (i32.load offset=8 (local.get $base)))
        (local.set $page (i32.load (local.get $aux)))
        (local.set $max_pos (local.get $smax))
        (if (i32.gt_u (local.get $page) (i32.const 1))
          (then
            (local.set $max_pos
              (if (result i32)
                (i32.gt_s
                  (i32.sub (local.get $smax) (i32.sub (local.get $page) (i32.const 1)))
                  (local.get $smin))
                (then (i32.sub (local.get $smax) (i32.sub (local.get $page) (i32.const 1))))
                (else (local.get $smin))))))
        (local.set $pos (i32.load (local.get $base)))
        (if (i32.lt_s (local.get $pos) (local.get $smin))
          (then (local.set $pos (local.get $smin))))
        (if (i32.gt_s (local.get $pos) (local.get $max_pos))
          (then (local.set $pos (local.get $max_pos))))
        (i32.store (local.get $base) (local.get $pos))
        ;; SetScrollInfo controls standard scrollbar visibility. A page that
        ;; covers the inclusive range hides the bar; otherwise USER adds the
        ;; corresponding non-client style and recalculates the client area.
        (local.set $style (call $wnd_get_style (local.get $arg0)))
        (local.set $bar_bit
          (select (i32.const 0x00200000) (i32.const 0x00100000)
                  (i32.ne (local.get $arg1) (i32.const 0))))
        (local.set $new_style (local.get $style))
        (if (i32.and
              (i32.gt_s (local.get $smax) (local.get $smin))
              (i32.or
                (i32.eqz (local.get $page))
                (i32.lt_u (local.get $page)
                  (i32.add (i32.sub (local.get $smax) (local.get $smin)) (i32.const 1)))))
          (then (local.set $new_style (i32.or (local.get $style) (local.get $bar_bit))))
          (else (local.set $new_style
            (i32.and (local.get $style) (i32.xor (local.get $bar_bit) (i32.const -1))))))
        (if (i32.ne (local.get $new_style) (local.get $style))
          (then
            (drop (call $wnd_set_style (local.get $arg0) (local.get $new_style)))
            (call $defwndproc_do_nccalcsize (local.get $arg0))
            (call $host_sync_window_client
              (local.get $arg0)
              (call $wnd_client_screen_x (local.get $arg0))
              (call $wnd_client_screen_y (local.get $arg0))
              (i32.sub (call $client_rect_get_r (local.get $arg0)) (call $client_rect_get_l (local.get $arg0)))
              (i32.sub (call $client_rect_get_b (local.get $arg0)) (call $client_rect_get_t (local.get $arg0))))))
        (if (i32.or
              (i32.ne (local.get $arg3) (i32.const 0))
              (i32.ne (local.get $new_style) (local.get $style)))
          (then
            (call $defwndproc_do_ncpaint (local.get $arg0))
            ;; ...and leave the non-client area marked dirty. Children share
            ;; their parent's back-canvas, so the client paint the app performs
            ;; right after this call can cover the bar we just drew; the pump's
            ;; NC drain puts it back. USER gets this for free from the window's
            ;; non-client update region.
            (call $nc_flags_set (local.get $arg0) (i32.const 1))))
        (global.set $eax (i32.load (local.get $base))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; 629: GetScrollInfo(hwnd, nBar, lpsi) → BOOL
  (func $handle_GetScrollInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $slot i32) (local $base i32) (local $aux i32) (local $lpsi i32) (local $fMask i32)
    (local.set $slot (call $wnd_table_find (local.get $arg0)))
    (local.set $lpsi (call $g2w (local.get $arg2)))
    (local.set $fMask (i32.load offset=4 (local.get $lpsi)))
    (if (i32.ge_s (local.get $slot) (i32.const 0))
      (then
        (local.set $base (i32.add (global.get $SCROLL_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 24))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 12)))))
        (local.set $aux (i32.add (global.get $SCROLL_AUX_TABLE)
          (i32.add (i32.mul (local.get $slot) (i32.const 16))
            (i32.mul (i32.ne (local.get $arg1) (i32.const 0)) (i32.const 8)))))
        ;; SIF_RANGE = 0x01
        (if (i32.and (local.get $fMask) (i32.const 1))
          (then
            (i32.store offset=8 (local.get $lpsi) (i32.load offset=4 (local.get $base)))
            (i32.store offset=12 (local.get $lpsi) (i32.load offset=8 (local.get $base)))))
        ;; SIF_POS = 0x04
        (if (i32.and (local.get $fMask) (i32.const 4))
          (then
            (i32.store offset=20 (local.get $lpsi) (i32.load (local.get $base)))))
        ;; SIF_PAGE = 0x02
        (if (i32.and (local.get $fMask) (i32.const 2))
          (then
            (i32.store offset=16 (local.get $lpsi) (i32.load (local.get $aux)))))
        ;; SIF_TRACKPOS = 0x10
        (if (i32.and (local.get $fMask) (i32.const 16))
          (then
            (i32.store offset=24 (local.get $lpsi) (i32.load offset=4 (local.get $aux)))))
        (global.set $eax (i32.const 1)))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; 630: ScrollWindow(hWnd, XAmount, YAmount, lpRect, lpClipRect)
  ;; Host scrolls the target client backing-store rectangle by the requested
  ;; delta and fills exposed strips. lpRect/lpClipRect are client-relative and
  ;; are clipped/intersected host-side.
  (func $handle_ScrollWindow (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (call $host_gdi_scroll_window
        (local.get $arg0) (local.get $arg1) (local.get $arg2)
        (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

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
    ;; WS_EX_CLIENTEDGE sinks the client two pixels on every side, and
    ;; $defwndproc_do_nccalcsize takes those two pixels back out. The two have
    ;; to agree: an app that sizes its window through this call and then lays
    ;; itself out inside GetClientRect gets four pixels less than it asked for
    ;; when they do not. Solitaire is exactly that app -- it asks for the width
    ;; seven card columns need, is handed four pixels less, decides the window
    ;; is too narrow to lay out at all, and leaves every pile at the origin.
    (if (i32.and (local.get $arg3) (i32.const 0x00000200)) (then
      (i32.store           (local.get $wa) (i32.sub (i32.load           (local.get $wa)) (i32.const 2)))
      (i32.store offset=4  (local.get $wa) (i32.sub (i32.load offset=4  (local.get $wa)) (i32.const 2)))
      (i32.store offset=8  (local.get $wa) (i32.add (i32.load offset=8  (local.get $wa)) (i32.const 2)))
      (i32.store offset=12 (local.get $wa) (i32.add (i32.load offset=12 (local.get $wa)) (i32.const 2)))
    ))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; stdcall, 4 args
  )

  ;; DispatchMessageW — see the note on $handle_GetMessageW. The parallel copy
  ;; did not know about the native status bar or tab control, so a W app with
  ;; either one silently lost their messages.
  (func $handle_DispatchMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_DispatchMessageA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  ;; PeekMessageW — see the note on $handle_GetMessageW. The A version was
  ;; missing twenty-two things this one does, timers and the post queue among
  ;; them.
  (func $handle_PeekMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_PeekMessageA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  ;; 637: SendDlgItemMessageW — routing and stack layout are identical to A,
  ;; and the message payload is opaque here: the control that receives it is
  ;; what interprets the buffer. Same treatment SendMessageW gets.
  (func $handle_SendDlgItemMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_SendDlgItemMessageA (local.get $arg0) (local.get $arg1)
      (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
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

  ;; 640: IsWindowEnabled
  (func $handle_IsWindowEnabled (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eq (call $wnd_table_find (local.get $arg0)) (i32.const -1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (global.set $eax
      (select (i32.const 0) (i32.const 1)
        (i32.and (call $wnd_get_style (local.get $arg0)) (i32.const 0x08000000))))
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

  ;; 646: GetWindowThreadProcessId
  (func $handle_GetWindowThreadProcessId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pid i32)
    ;; GetWindowThreadProcessId(hWnd, lpdwProcessId) → threadId
    ;; Renderer-owned top-level enumeration can return an HWND from another
    ;; emulator instance, so ask the shared host window registry first.
    (local.set $pid (call $host_get_window_info (local.get $arg0) (i32.const 3)))
    ;; Headless/minimal hosts may not mirror windows. A HWND in our local USER
    ;; table still belongs to this process.
    (if (i32.eqz (local.get $pid))
      (then
        (if (i32.ge_s (call $wnd_table_find (local.get $arg0)) (i32.const 0))
          (then (local.set $pid (call $current_process_id))))))
    ;; Invalid HWND: return zero and leave the caller's PID storage untouched.
    (if (i32.eqz (local.get $pid))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (local.get $pid))))
    (global.set $eax (i32.const 1))  ;; fake thread ID = 1
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; GetMessageW — the A pump, which is the maintained one.
  ;;
  ;; This used to be a 189-line parallel copy of $handle_GetMessageA, and it
  ;; had fallen behind: no WM_NCPAINT delivery (the $nc_flags_scan pass), no
  ;; virtual-LAN pump, no per-message hwnd/lParam from the input queue, no
  ;; WM_NCCALCSIZE for a child's WM_SIZE. Its one piece of unique state,
  ;; $pending_wm_create, was dead — nothing in the module ever set it, so the
  ;; WM_NCCREATE/WM_CREATE arms it carried could not run.
  ;;
  ;; A and W differ in the *encoding of text payloads*, and nothing in this
  ;; emulator produces a non-ASCII WM_CHAR, so there is nothing left to
  ;; translate. If that changes, convert here rather than forking the pump.
  (func $handle_GetMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_GetMessageA (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  ;; 648: DefFrameProcW — STUB: unimplemented
  (func $handle_DefFrameProcW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 649: TranslateMDISysAccel — STUB: unimplemented
  (func $handle_TranslateMDISysAccel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
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
  ;; SetParent(hWndChild=arg0, hWndNewParent=arg1) — returns previous parent (0 if none).
  (func $handle_SetParent (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $wnd_get_parent (local.get $arg0)))
    (call $wnd_set_parent (local.get $arg0) (local.get $arg1))
    (call $host_set_parent (local.get $arg0) (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

rDragDrop(hwnd, pDropTarget) — return S_OK.
  ;; No real drag/drop path: there is no host OS drop source to deliver IDataObjects
  ;; from, so tracking the IDropTarget would be pure bookkeeping. Return S_OK so
  ;; callers proceed; any later drop events simply never arrive.
  (func $handle_RegisterDragDrop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; RevokeDragDrop(hwnd) — return S_OK, matching the RegisterDragDrop no-op above.
  (func $handle_RevokeDragDrop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CoLockObjectExternal(pUnk, fLock, fLastUnlockReleases) — return S_OK.
  ;; mspaint probes this via GetProcAddress at startup and bails with a fatal
  ;; MessageBox if unresolved. No real OOP server lifetime to manage.
  (func $handle_CoLockObjectExternal (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

;; 657: GetDCEx — STUB: unimplemented
  (func $handle_GetDCEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hdc i32)
    ;; GetDCEx(hwnd, hrgnClip, flags). Minimal USER/GDI compatibility:
    ;; ignore the optional region for now, but honor DCX_WINDOW enough for MFC
    ;; toolbar/nonclient update code to choose whole-window vs client origin.
    ;; hwnd=NULL and the fixed desktop hwnd both use the host screen DC path.
    (if (i32.or
          (i32.eqz (local.get $arg0))
          (i32.or
            (i32.eq (local.get $arg0) (i32.const 0x00010000))
            (i32.eq (call $wnd_table_find (local.get $arg0)) (i32.const -1))))
      (then
        (local.set $hdc (call $host_alloc_screen_dc)))
      (else
        (if (i32.and (local.get $arg2) (i32.const 0x00000001)) ;; DCX_WINDOW
          (then
            (local.set $hdc (call $host_alloc_window_dc (local.get $arg0) (i32.const 1)))
            (call $dc_apply_window_clip (local.get $hdc) (local.get $arg0)))
          (else
            (local.set $hdc (call $host_alloc_window_dc (local.get $arg0) (i32.const 0)))
            (call $dc_apply_client_clip (local.get $hdc) (local.get $arg0))))))
    (global.set $eax (local.get $hdc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 658: LockWindowUpdate — STUB: unimplemented
  (func $handle_LockWindowUpdate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; LockWindowUpdate(hWndLock) blocks drawing to all other windows until
    ;; unlocked with NULL. WordPad/MFC uses it around toolbar command UI
    ;; updates. We do not maintain host-side window locks, so accept both lock
    ;; and unlock requests as successful no-ops.
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 659: GetTabbedTextExtentA — packed width/height for tab-expanded text.
  (func $handle_GetTabbedTextExtentA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_tabbed_text
      (local.get $arg0) (i32.const 0) (i32.const 0)
      (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (i32.const 0) (i32.const 0) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 660: CreateDialogIndirectParamW — STUB: unimplemented
  (func $handle_CreateDialogIndirectParamW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $hwnd i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $dlg_indirect_template_ptr (local.get $arg1))
    (call $handle_CreateDialogParamA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
    (call $wnd_unicode_set (local.get $hwnd) (i32.const 1))
  )

  (func $handle_CreateDialogIndirectParamA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $dlg_indirect_template_ptr (local.get $arg1))
    (call $handle_CreateDialogParamA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 661: GetNextDlgTabItem — use the same visible/enabled WS_TABSTOP walk as
  ;; IsDialogMessage keyboard traversal. bPrevious selects reverse order and
  ;; both directions wrap at the ends, matching USER32.
  (func $handle_GetNextDlgTabItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (call $dialog_next_tabstop (local.get $arg0) (local.get $arg1)
        (select (i32.const -1) (i32.const 1) (local.get $arg2))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 662: GetAsyncKeyState — STUB: unimplemented
  ;; GetAsyncKeyState(vKey) — stdcall(1). Reports current key state via host.
  (func $handle_GetAsyncKeyState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_get_async_key_state (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
  )

  ;; 663: MapDialogRect(hDlg, lpRect) — convert dialog units to pixels.
  (func $handle_MapDialogRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32)
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $p (call $g2w (local.get $arg1)))
    ;; x pixels = MulDiv(dialogX, baseX=6, 4)
    (i32.store offset=0 (local.get $p)
      (i32.div_s (i32.mul (i32.load offset=0 (local.get $p)) (i32.const 6)) (i32.const 4)))
    (i32.store offset=8 (local.get $p)
      (i32.div_s (i32.mul (i32.load offset=8 (local.get $p)) (i32.const 6)) (i32.const 4)))
    ;; y pixels = MulDiv(dialogY, baseY=13, 8)
    (i32.store offset=4 (local.get $p)
      (i32.div_s (i32.mul (i32.load offset=4 (local.get $p)) (i32.const 13)) (i32.const 8)))
    (i32.store offset=12 (local.get $p)
      (i32.div_s (i32.mul (i32.load offset=12 (local.get $p)) (i32.const 13)) (i32.const 8)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 664: GetDialogBaseUnits() → DWORD (loword=X, hiword=Y base units)
  ;; Standard dialog units based on system font (8pt MS Sans Serif: 6x13)
  (func $handle_GetDialogBaseUnits (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.or (i32.const 6) (i32.shl (i32.const 13) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))

  ;; 665: GetClassNameW(hwnd, lpClassName, nMaxCount) → chars copied.
  ;; The class name comes from the same place GetClassNameA reads it; only
  ;; the encoding handed back differs. A window class named in wide characters
  ;; still matches ASCII everywhere else in this emulator, so a narrow read
  ;; and a widen is the whole of it.
  (func $handle_GetClassNameW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $len i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $arg1)) (i32.le_s (local.get $arg2) (i32.const 0)))
      (then (global.set $eax (i32.const 0)) (return)))
    (i32.store16 (call $g2w (local.get $arg1)) (i32.const 0))
    (local.set $tmp (call $heap_alloc (local.get $arg2)))
    (if (i32.eqz (local.get $tmp))
      (then (global.set $eax (i32.const 0)) (return)))
    (call $gs8 (local.get $tmp) (i32.const 0))
    (local.set $len (call $host_get_window_class
      (local.get $arg0) (call $g2w (local.get $tmp)) (local.get $arg2)))
    (drop (call $ansi_to_wide (local.get $tmp) (local.get $arg1) (local.get $arg2)))
    (call $heap_free (local.get $tmp))
    (global.set $eax (local.get $len))
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

  ;; 667: GetDlgItemTextW(hDlg, nIDDlgItem, lpString, cchMax) — the same read
  ;; GetDlgItemTextA does, staged through an ANSI buffer of the same character
  ;; count and widened into the caller's. It used to answer "" for every
  ;; control, which is a wrong answer rather than a missing one.
  (func $handle_GetDlgItemTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $len i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (if (i32.or (i32.eqz (local.get $arg2)) (i32.le_s (local.get $arg3) (i32.const 0)))
      (then (global.set $eax (i32.const 0)) (return)))
    (i32.store16 (call $g2w (local.get $arg2)) (i32.const 0))
    (local.set $tmp (call $heap_alloc (local.get $arg3)))
    (if (i32.eqz (local.get $tmp))
      (then (global.set $eax (i32.const 0)) (return)))
    (call $gs8 (local.get $tmp) (i32.const 0))
    (local.set $len (call $dlg_item_text_ansi
      (local.get $arg0) (local.get $arg1) (local.get $tmp) (local.get $arg3)))
    (drop (call $ansi_to_wide (local.get $tmp) (local.get $arg2) (local.get $arg3)))
    (call $heap_free (local.get $tmp))
    (global.set $eax (local.get $len))
  )

  ;; 668: SetDlgItemTextW — return 1, 3 args stdcall
  ;; SetDlgItemTextW(hDlg, nIDDlgItem, lpString) — narrow and hand to the A
  ;; path, which owns the window-text table and the WM_SETTEXT dispatch.
  ;;
  ;; This used to return TRUE without storing anything. Every field a Unicode
  ;; app filled in was then blank with no diagnostic: XP Sound Recorder's
  ;; File > Properties sets its name, copyright, length, data size and audio
  ;; format this way, and the whole sheet rendered empty.
  (func $handle_SetDlgItemTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $narrow i32) (local $n i32)
    (if (i32.ge_u (local.get $arg2) (i32.const 0x10000))
      (then
        (local.set $n (i32.add (call $guest_wcslen (local.get $arg2)) (i32.const 1)))
        (local.set $narrow (call $heap_alloc (local.get $n)))
        (if (local.get $narrow)
          (then (drop (call $wide_to_ansi
                  (local.get $arg2) (local.get $narrow) (local.get $n)))))))
    (call $handle_SetDlgItemTextA
      (local.get $arg0) (local.get $arg1) (local.get $narrow)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
    (if (local.get $narrow) (then (call $heap_free (local.get $narrow))))
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

  ;; 670: ScrollWindowEx(hWnd, dx, dy, prcScroll, prcClip, hrgnUpdate,
  ;;                     prcUpdate, flags) → region complexity.
  ;; Scroll the host backing store when possible, report the invalidated area,
  ;; and mark the window for repaint. Region details are approximated to a
  ;; single rectangle, but prcScroll/prcClip are intersected in client coords.
  (func $handle_ScrollWindowEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $l i32) (local $t i32) (local $r i32) (local $b i32)
    (local $wa i32) (local $cs i32) (local $prcUpdate i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
        (return)))
    (drop
      (call $host_gdi_scroll_window
        (local.get $arg0) (local.get $arg1) (local.get $arg2)
        (local.get $arg3) (local.get $arg4)))
    (if (local.get $arg3)
      (then
        (local.set $wa (call $g2w (local.get $arg3)))
        (local.set $l (i32.load (local.get $wa)))
        (local.set $t (i32.load offset=4 (local.get $wa)))
        (local.set $r (i32.load offset=8 (local.get $wa)))
        (local.set $b (i32.load offset=12 (local.get $wa))))
      (else
        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
        (local.set $l (i32.const 0))
        (local.set $t (i32.const 0))
        (local.set $r (i32.and (local.get $cs) (i32.const 0xFFFF)))
        (local.set $b (i32.shr_u (local.get $cs) (i32.const 16)))))
    (if (local.get $arg4)
      (then
        (local.set $wa (call $g2w (local.get $arg4)))
        (if (i32.gt_s (i32.load (local.get $wa)) (local.get $l))
          (then (local.set $l (i32.load (local.get $wa)))))
        (if (i32.gt_s (i32.load offset=4 (local.get $wa)) (local.get $t))
          (then (local.set $t (i32.load offset=4 (local.get $wa)))))
        (if (i32.lt_s (i32.load offset=8 (local.get $wa)) (local.get $r))
          (then (local.set $r (i32.load offset=8 (local.get $wa)))))
        (if (i32.lt_s (i32.load offset=12 (local.get $wa)) (local.get $b))
          (then (local.set $b (i32.load offset=12 (local.get $wa)))))))
    ;; prcUpdate is the 7th argument at [esp+28].
    (local.set $prcUpdate (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (if (i32.or
          (i32.le_s (local.get $r) (local.get $l))
          (i32.le_s (local.get $b) (local.get $t)))
      (then
        (if (local.get $prcUpdate)
          (then
            (local.set $wa (call $g2w (local.get $prcUpdate)))
            (i64.store (local.get $wa) (i64.const 0))
            (i64.store offset=8 (local.get $wa) (i64.const 0))))
        (global.set $eax (i32.const 1)) ;; NULLREGION
        (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
        (return)))
    (if (local.get $prcUpdate)
      (then
        (local.set $wa (call $g2w (local.get $prcUpdate)))
        (i32.store (local.get $wa) (local.get $l))
        (i32.store offset=4 (local.get $wa) (local.get $t))
        (i32.store offset=8 (local.get $wa) (local.get $r))
        (i32.store offset=12 (local.get $wa) (local.get $b))))
    (call $update_invalidate_rect (local.get $arg0) (local.get $l) (local.get $t) (local.get $r) (local.get $b))
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
      (then (global.set $paint_pending (i32.const 1)))
      (else (call $paint_flag_set (local.get $arg0))))
    (call $host_invalidate (local.get $arg0))
    (global.set $eax (i32.const 2)) ;; SIMPLEREGION
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))
  )

  ;; 671: IsDialogMessageW — same policy as A: let the app dispatch messages.
  (func $handle_IsDialogMessageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_IsDialogMessageA
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

Layout(hdc) -> DWORD — return 0 (LTR layout)
 676: SetCursorPos(x, y) → BOOL — 2 args stdcall
  (func $handle_SetCursorPos (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $host_set_mouse_position (local.get $arg0) (local.get $arg1))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 677: DestroyCursor — STUB: unimplemented
  ;; DestroyCursor(hCursor). LoadCursor hands back an encoded handle with no
  ;; allocation behind it, so there is nothing to release — same situation as
  ;; DestroyIcon. A NULL handle is still an error, which is the one part of
  ;; the contract a caller can actually observe.
  (func $handle_DestroyCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.ne (local.get $arg0) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 678: FindWindowW(lpClassName, lpWindowName) → HWND
  ;; Searches for a top-level window. Returns NULL (no other instances running).
  ;; Apps use this to detect if they're already running.
  (func $handle_FindWindowW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 679: GetTabbedTextExtentW — packed width/height for UTF-16 text.
  (func $handle_GetTabbedTextExtentW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_tabbed_text
      (local.get $arg0) (i32.const 0) (i32.const 0)
      (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (i32.const 0) (i32.const 1) (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 680: UnregisterClassW — STUB: unimplemented
  (func $handle_UnregisterClassW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 681: ShowOwnedPopups(hwndOwner, fShow) — single-window model has no popups
  ;; to enumerate, so the show/hide is a no-op. Return TRUE.
  (func $handle_ShowOwnedPopups (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

84: CopyAcceleratorTableW — STUB: unimplemented
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

  ;; EnumThreadWindows(dwThreadId, lpfn, lParam) — the emulator exposes one
  ;; application thread/window set. Match EnumWindows' current empty-success
  ;; enumeration until chained guest callbacks are available. WinHelp uses
  ;; this as a best-effort sweep for secondary windows while rebuilding GID.
  (func $handle_EnumThreadWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; EnumSystemCodePagesA(lpCodePageEnumProc, dwFlags) — report successful
  ;; enumeration. The emulator exposes its fixed ANSI/OEM code-page model via
  ;; GetACP/GetOEMCP; Win98 FTSRCH only requires this startup probe to succeed.
  (func $handle_EnumSystemCodePagesA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
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

 688: WindowFromDC — STUB: unimplemented
  (func $handle_WindowFromDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 689: CountClipboardFormats()
  (func $handle_CountClipboardFormats (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg0))
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (call $clipboard_count_formats))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; EmptyClipboard() — clear all supported non-OLE clipboard data.
  (func $handle_EmptyClipboard (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg0))
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (call $clipboard_clear_all_data)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; SetClipboardData(uFormat, hMem) — copy CF_TEXT/CF_OEMTEXT and registered
  ;; non-OLE Rich Text Format payloads into emulator-owned buffers. CF_DIB is
  ;; copied as opaque HGLOBAL bytes for the RichEdit static-object path. Other
  ;; formats remain inert success until their ownership rules are implemented.
  (func $handle_SetClipboardData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $len i32) (local $need i32) (local $cap i32)
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (if (i32.eqz (local.get $arg1))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (i32.and
          (i32.ne (global.get $clipboard_rtf_format_id) (i32.const 0))
          (i32.eq (local.get $arg0) (global.get $clipboard_rtf_format_id)))
      (then
        (global.set $eax
          (if (result i32) (call $clipboard_store_rtf_data (local.get $arg1))
            (then (local.get $arg1))
            (else (i32.const 0))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (i32.eqz
          (i32.or (i32.eq (local.get $arg0) (i32.const 1))  ;; CF_TEXT
                  (i32.eq (local.get $arg0) (i32.const 7)))) ;; CF_OEMTEXT
      (then
        (if (i32.eq (local.get $arg0) (i32.const 8)) ;; CF_DIB
          (then
            (global.set $eax (call $clipboard_store_binary_data (local.get $arg0) (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        (global.set $eax (local.get $arg1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (call $richedit_clipboard_clear_format)
    (local.set $len (call $guest_strlen (local.get $arg1)))
    (local.set $need (i32.add (local.get $len) (i32.const 1)))
    (if (i32.gt_u (local.get $need) (global.get $clipboard_cap))
      (then
        (if (global.get $clipboard_ptr)
          (then (call $heap_free (global.get $clipboard_ptr))
                (global.set $clipboard_ptr (i32.const 0))))
        (local.set $cap (i32.and (i32.add (local.get $need) (i32.const 63)) (i32.const -64)))
        (global.set $clipboard_ptr (call $heap_alloc (local.get $cap)))
        (global.set $clipboard_cap (local.get $cap))))
    (if (i32.eqz (global.get $clipboard_ptr))
      (then
        (global.set $clipboard_len (i32.const 0))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (call $memcpy (call $g2w (global.get $clipboard_ptr)) (call $g2w (local.get $arg1)) (local.get $need))
    (global.set $clipboard_len (local.get $len))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; GetClipboardOwner() — no cross-window ownership model yet.
  (func $handle_GetClipboardOwner (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (local.get $arg0))
    (drop (local.get $arg1))
    (drop (local.get $arg2))
    (drop (local.get $arg3))
    (drop (local.get $arg4))
    (drop (local.get $name_ptr))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; 690: SetWindowContextHelpId — STUB: unimplemented
  (func $handle_SetWindowContextHelpId (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 691: GetNextDlgGroupItem — STUB: unimplemented
  (func $handle_GetNextDlgGroupItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 692: ClipCursor(lprc) — store the screen-coordinate confinement rect.
  ;; JS clamps subsequent mouse input to this rect so apps that watch for the
  ;; cursor reaching a clipped edge (Bricks/Klotski) see Win32-like coords.
  (func $handle_ClipCursor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rc i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $clip_cursor_active (i32.const 0))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $rc (call $g2w (local.get $arg0)))
    (global.set $clip_cursor_l (i32.load (local.get $rc)))
    (global.set $clip_cursor_t (i32.load offset=4 (local.get $rc)))
    (global.set $clip_cursor_r (i32.load offset=8 (local.get $rc)))
    (global.set $clip_cursor_b (i32.load offset=12 (local.get $rc)))
    (global.set $clip_cursor_active
      (i32.and
        (i32.lt_s (global.get $clip_cursor_l) (global.get $clip_cursor_r))
        (i32.lt_s (global.get $clip_cursor_t) (global.get $clip_cursor_b))))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 693: EnumChildWindows — STUB: unimplemented
  ;; EnumChildWindows(hwndParent, lpEnumFunc, lParam)
  ;;
  ;; Win32 enumerates every descendant, not just immediate children, and stops
  ;; early when the callback returns FALSE. Each callback is a guest call, so
  ;; the walk suspends on the CACA002B continuation and resumes at the next
  ;; slot — the same shape as the D3D device enumerators.
  (func $enum_child_is_descendant (param $hwnd i32) (param $ancestor i32) (result i32)
    (local $p i32) (local $guard i32)
    (local.set $p (call $wnd_get_parent (local.get $hwnd)))
    (block $done (loop $walk
      (br_if $done (i32.eqz (local.get $p)))
      (if (i32.eq (local.get $p) (local.get $ancestor)) (then (return (i32.const 1))))
      ;; A malformed parent chain must not spin forever.
      (local.set $guard (i32.add (local.get $guard) (i32.const 1)))
      (br_if $done (i32.ge_u (local.get $guard) (global.get $MAX_WINDOWS)))
      (local.set $p (call $wnd_get_parent (local.get $p)))
      (br $walk)))
    (i32.const 0))

  ;; Finish the walk: drop the saved API return address and resume the caller.
  ;; EnumChildWindows reports TRUE whenever it ran, including a callback-
  ;; requested early stop.
  (func $enum_child_finish
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (global.set $eip (global.get $enum_child_ret))
    (global.set $enum_child_depth (i32.const 0))
    (global.set $eax (i32.const 1)))

  ;; Invoke the callback for the next descendant at or after $enum_child_slot.
  (func $enum_child_dispatch
    (local $slot i32) (local $hwnd i32)
    (local.set $slot (global.get $enum_child_slot))
    (block $found (loop $scan
      (if (i32.ge_u (local.get $slot) (global.get $MAX_WINDOWS))
        (then (call $enum_child_finish) (return)))
      (local.set $hwnd (call $wnd_slot_hwnd (local.get $slot)))
      (br_if $found
        (i32.and
          (i32.ne (local.get $hwnd) (i32.const 0))
          (call $enum_child_is_descendant (local.get $hwnd) (global.get $enum_child_parent))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br $scan)))
    (global.set $enum_child_slot (local.get $slot))
    ;; WNDENUMPROC(hwnd, lParam), stdcall — push right to left.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $enum_child_lparam))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $hwnd))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $enum_child_thunk))
    (global.set $eip (global.get $enum_child_cb))
    (global.set $steps (i32.const 0)))

  ;; CACA002B: the callback returned. FALSE stops the walk.
  (func $enum_child_continue
    (if (i32.eqz (global.get $eax))
      (then (call $enum_child_finish) (return)))
    (global.set $enum_child_slot (i32.add (global.get $enum_child_slot) (i32.const 1)))
    (call $enum_child_dispatch))

  (func $handle_EnumChildWindows (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret i32)
    (local.set $ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) ;; ret addr + 3 args
    ;; No callback, or a callback re-entering the walk we are already running:
    ;; report success without touching the outer iteration state.
    (if (i32.or (i32.eqz (local.get $arg1)) (global.get $enum_child_depth))
      (then
        (global.set $eax (i32.const 1))
        (global.set $eip (local.get $ret))
        (return)))
    (global.set $enum_child_depth (i32.const 1))
    (global.set $enum_child_parent (local.get $arg0))
    (global.set $enum_child_cb (local.get $arg1))
    (global.set $enum_child_lparam (local.get $arg2))
    (global.set $enum_child_ret (local.get $ret))
    (global.set $enum_child_slot (i32.const 0))
    ;; Keep the API return address below the callback's stdcall frame.
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret))
    (call $enum_child_dispatch)
  )

  ;; 694: InvalidateRgn(hwnd, hrgn, bErase). hrgn=NULL → full client rect.
  (func $handle_InvalidateRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $cs i32) (local $rt i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (local.get $arg1)
      (then
        (local.set $rt (call $gdi_rgn_get_box (local.get $arg1) (global.get $PAINT_SCRATCH)))
        (if (local.get $rt)
          (then
            (call $update_invalidate_rect (local.get $arg0)
              (i32.load (global.get $PAINT_SCRATCH))
              (i32.load offset=4 (global.get $PAINT_SCRATCH))
              (i32.load offset=8 (global.get $PAINT_SCRATCH))
              (i32.load offset=12 (global.get $PAINT_SCRATCH)))))))
      (else
        (local.set $cs (call $host_get_window_client_size (local.get $arg0)))
        (call $update_invalidate_rect (local.get $arg0) (i32.const 0) (i32.const 0)
          (i32.and (local.get $cs) (i32.const 0xFFFF))
          (i32.shr_u (local.get $cs) (i32.const 16)))))
    (if (i32.eq (local.get $arg0) (global.get $main_hwnd))
      (then (global.set $paint_pending (i32.const 1)))
      (else (call $paint_flag_set (local.get $arg0))))
    (call $host_invalidate (local.get $arg0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
  )

  ;; 695: LoadStringW — load UTF-16 string resource
  (func $handle_LoadStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $push_rsrc_ctx (local.get $arg0))
    (global.set $eax (call $string_load_w
      (local.get $arg1)                ;; string ID
      (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
      (local.get $arg3)))              ;; max chars
    (call $pop_rsrc_ctx)
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; 696: CharUpperW(lpsz) — the wide twin of CharUpperA, with the same two
  ;; modes: a HIWORD of 0 means lpsz is a single character rather than a
  ;; pointer, and a string is uppercased in place. Only a-z is folded, which
  ;; is the same range the ANSI side folds; the rest of UTF-16 is left alone
  ;; rather than guessed at.
  ;; CharUpper's two spellings differ only in the width of the characters they
  ;; walk: with a high word of zero the argument is a single character to
  ;; uppercase and return, otherwise it is a pointer to a string uppercased in
  ;; place. Returns the input unchanged (char or pointer) either way.
  (func $char_upper (param $arg i32) (param $wide i32) (result i32)
    (local $p_g i32) (local $c i32) (local $step i32)
    (if (i32.eqz (i32.and (local.get $arg) (i32.const 0xffff0000)))
      (then
        (local.set $c (i32.and (local.get $arg)
          (select (i32.const 0xffff) (i32.const 0xff) (local.get $wide))))
        (if (i32.and (i32.ge_u (local.get $c) (i32.const 0x61))
                     (i32.le_u (local.get $c) (i32.const 0x7a)))
          (then (return (i32.sub (local.get $c) (i32.const 0x20)))))
        (return (local.get $arg))))
    (local.set $step (select (i32.const 2) (i32.const 1) (local.get $wide)))
    (local.set $p_g (local.get $arg))
    (block $done (loop $lp
      (local.set $c (call $gl_char (local.get $p_g) (local.get $wide)))
      (br_if $done (i32.eqz (local.get $c)))
      (if (i32.and (i32.ge_u (local.get $c) (i32.const 0x61))
                   (i32.le_u (local.get $c) (i32.const 0x7a)))
        (then (call $store_char (local.get $p_g)
                (i32.sub (local.get $c) (i32.const 0x20)) (local.get $wide))))
      (local.set $p_g (i32.add (local.get $p_g) (local.get $step)))
      (br $lp)))
    (local.get $arg))

  (func $handle_CharUpperW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $char_upper (local.get $arg0) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CharUpperA(lpsz) — if high word is 0, uppercase the single char; else
  ;; lpsz is a pointer to a nul-terminated ANSI string uppercased in place.
  ;; Returns the input unchanged (char or pointer).
  (func $handle_CharUpperA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $char_upper (local.get $arg0) (i32.const 0)))
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

  ;; ImmNotifyIME(hIMC, action, index, value) → BOOL. We do not create an
  ;; input context or composition state, so there is nothing to notify.
  (func $handle_ImmNotifyIME (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
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

  ;; CharLowerBuffA(lpsz, cchLength) — lowercase exactly cchLength ANSI bytes
  ;; in place. Returns the number of bytes processed.
  (func $handle_CharLowerBuffA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $i i32) (local $c i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $p (call $g2w (local.get $arg0)))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg1)))
      (local.set $c (i32.load8_u (i32.add (local.get $p) (local.get $i))))
      (if (i32.and
            (i32.ge_u (local.get $c) (i32.const 0x41))
            (i32.le_u (local.get $c) (i32.const 0x5a)))
        (then
          (i32.store8
            (i32.add (local.get $p) (local.get $i))
            (i32.add (local.get $c) (i32.const 0x20)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; CharUpperBuffA(lpsz, cchLength) — uppercase cchLength characters in
  ;; place and return how many were converted. Unlike CharUpperA this does not
  ;; stop at a NUL: the count is the whole contract.
  (func $handle_CharUpperBuffA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $p i32) (local $i i32) (local $c i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $p (call $g2w (local.get $arg0)))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $arg1)))
      (local.set $c (i32.load8_u (i32.add (local.get $p) (local.get $i))))
      (if (i32.and
            (i32.ge_u (local.get $c) (i32.const 0x61))
            (i32.le_u (local.get $c) (i32.const 0x7a)))
        (then
          (i32.store8
            (i32.add (local.get $p) (local.get $i))
            (i32.sub (local.get $c) (i32.const 0x20)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $eax (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
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

  ;; Winsock handlers (socket, bind, listen, accept, connect, send, recv,
  ;; select, shutdown, ioctlsocket, setsockopt, the byte-order and address
  ;; helpers, and the WSA* lifecycle) live in 09d-winsock.wat, which owns
  ;; the virtual LAN socket switch described in docs/virtual-lan-party.md.

  ;; 921: SetWindowRgn(hwnd, hRgn, bRedraw) — 3 args stdcall
  (func $handle_SetWindowRgn (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rect i32) (local $w i32) (local $h i32)
    ;; This is the only consumer of the JS-side region mirror, so it is the
    ;; place that pays for it. Regions do not push their bands across on
    ;; creation any more (see $gdi_rgn_sync_mirror in 10-helpers.wat); prime
    ;; this one now, and from here on its mutations propagate.
    (if (local.get $arg1)
      (then (drop (call $gdi_rgn_mirror_ensure (local.get $arg1)))))
    (global.set $eax (call $host_gdi_set_window_rgn
      (local.get $arg0) (call $gdi_rgn_host_handle (local.get $arg1)) (local.get $arg2)))
    (if (global.get $eax)
      (then
        (call $wnd_region_set
          (local.get $arg0)
          (i32.ne (local.get $arg1) (i32.const 0)))
        ;; Regioned skin windows draw and route input over the whole shaped
        ;; surface. Keep WAT client-origin exports aligned with that surface.
        (if (local.get $arg1)
          (then
            (local.set $rect (global.get $PAINT_SCRATCH))
            (call $host_get_window_rect (local.get $arg0) (local.get $rect))
            (local.set $w (i32.sub
              (i32.load offset=8 (local.get $rect))
              (i32.load (local.get $rect))))
            (local.set $h (i32.sub
              (i32.load offset=12 (local.get $rect))
              (i32.load offset=4 (local.get $rect))))
            (if (i32.and
                  (i32.gt_s (local.get $w) (i32.const 0))
                  (i32.gt_s (local.get $h) (i32.const 0)))
              (then
                (call $client_rect_set
                  (local.get $arg0)
                  (i32.const 0) (i32.const 0)
                  (local.get $w) (local.get $h)))))
          (else
            (call $defwndproc_do_nccalcsize (local.get $arg0))))))
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
  ;; Fill MONITORINFO with the current desktop size.
  (func $handle_GetMonitorInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $screen i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $screen (call $host_get_screen_size))
    ;; MONITORINFO: cbSize(4), rcMonitor(16), rcWork(16), dwFlags(4) = 40 bytes
    ;; rcMonitor: left=0, top=0, right=screenW, bottom=screenH
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))   ;; left
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0))   ;; top
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.and (local.get $screen) (i32.const 0xFFFF))) ;; right
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.shr_u (local.get $screen) (i32.const 16))) ;; bottom
    ;; rcWork: same as rcMonitor
    (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 0))
    (i32.store (i32.add (local.get $wa) (i32.const 24)) (i32.const 0))
    (i32.store (i32.add (local.get $wa) (i32.const 28)) (i32.and (local.get $screen) (i32.const 0xFFFF)))
    (i32.store (i32.add (local.get $wa) (i32.const 32)) (i32.shr_u (local.get $screen) (i32.const 16)))
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

  ;; 953: PrintDlgA(lppd) — default printer data plus interactive form
  (func $handle_PrintDlgA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32) (local $flags i32)
    (local $devmode i32) (local $devnames i32)
    (call $modal_capture_nonvolatile)
    (local.set $flags (call $gl32 (i32.add (local.get $arg0) (i32.const 20))))
    ;; Stable DEVMODEA/DEVNAMES handles. Global handles are direct guest heap
    ;; pointers in this runtime, so GlobalLock remains identity as MFC expects.
    (local.set $devmode (call $heap_alloc (i32.const 156)))
    (memory.fill (call $g2w (local.get $devmode)) (i32.const 0) (i32.const 156))
    (call $gs16 (i32.add (local.get $devmode) (i32.const 36)) (i32.const 156)) ;; dmSize
    (call $gs32 (i32.add (local.get $devmode) (i32.const 40)) (i32.const 0x00000F03)) ;; orientation/paper/copies/quality
    (call $gs16 (i32.add (local.get $devmode) (i32.const 44)) (i32.const 1))   ;; portrait
    (call $gs16 (i32.add (local.get $devmode) (i32.const 46)) (i32.const 1))   ;; Letter
    (call $gs16 (i32.add (local.get $devmode) (i32.const 48)) (i32.const 2794)) ;; 11in in 0.1mm
    (call $gs16 (i32.add (local.get $devmode) (i32.const 50)) (i32.const 2159)) ;; 8.5in
    (call $gs16 (i32.add (local.get $devmode) (i32.const 54)) (i32.const 1))   ;; copies
    (call $gs16 (i32.add (local.get $devmode) (i32.const 58)) (i32.const 300)) ;; print quality
    (local.set $devnames (call $heap_alloc (i32.const 32)))
    (memory.fill (call $g2w (local.get $devnames)) (i32.const 0) (i32.const 32))
    (call $gs16 (local.get $devnames) (i32.const 8))
    (call $gs16 (i32.add (local.get $devnames) (i32.const 2)) (i32.const 16))
    (call $gs16 (i32.add (local.get $devnames) (i32.const 4)) (i32.const 28))
    (call $gs16 (i32.add (local.get $devnames) (i32.const 6)) (i32.const 0))
    (call $memcpy (i32.add (call $g2w (local.get $devnames)) (i32.const 8)) (i32.const 0x11220) (i32.const 8)) ;; WINSPOOL
    (call $memcpy (i32.add (call $g2w (local.get $devnames)) (i32.const 16)) (i32.const 0x11229) (i32.const 12)) ;; Web Printer
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (local.get $devmode))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (local.get $devnames))
    (global.set $printer_hdc (call $gdi_printer_dc_alloc))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 16)) (global.get $printer_hdc))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 24)) (i32.const 1))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 26)) (i32.const 1))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 28)) (i32.const 1))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 30)) (i32.const 9999))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 32)) (i32.const 1))
    ;; PD_RETURNDEFAULT (0x400) is a noninteractive default-printer probe.
    (if (i32.and (local.get $flags) (i32.const 0x00000400))
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (global.set $common_dialog_kind (i32.const 2))
    (global.set $common_dialog_struct (local.get $arg0))
    (call $create_print_dialog (local.get $dlg) (local.get $owner))
    (call $modal_begin (local.get $dlg) (i32.const 8)))

  ;; PrintDlgW(lppd) — the wide twin of PrintDlgA.
  ;;
  ;; NT Paint delay-loads this, so a failed GetProcAddress does not return an
  ;; error to the app: the delay-load helper raises 0xC06D007F, nothing handles
  ;; it, and the process exits. File > Print, Page Setup and Print Preview all
  ;; killed Paint outright rather than doing nothing.
  ;;
  ;; PRINTDLG itself has the same layout in both flavours; DEVMODE does not.
  ;; DEVMODEW's dmDeviceName is 32 WCHARs rather than 32 chars, so every field
  ;; after it sits 32 bytes further along and the struct is 220 bytes, not 156.
  ;; DEVNAMES offsets are counted in characters, so those move too.
  (func $handle_PrintDlgW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32) (local $owner i32) (local $flags i32)
    (local $devmode i32) (local $devnames i32) (local $dn_w i32)
    (call $modal_capture_nonvolatile)
    (local.set $flags (call $gl32 (i32.add (local.get $arg0) (i32.const 20))))
    (local.set $devmode (call $heap_alloc (i32.const 220)))
    (memory.fill (call $g2w (local.get $devmode)) (i32.const 0) (i32.const 220))
    (call $gs16 (i32.add (local.get $devmode) (i32.const 68)) (i32.const 220)) ;; dmSize
    (call $gs32 (i32.add (local.get $devmode) (i32.const 72)) (i32.const 0x00000F03)) ;; dmFields
    (call $gs16 (i32.add (local.get $devmode) (i32.const 76)) (i32.const 1))    ;; portrait
    (call $gs16 (i32.add (local.get $devmode) (i32.const 78)) (i32.const 1))    ;; Letter
    (call $gs16 (i32.add (local.get $devmode) (i32.const 80)) (i32.const 2794)) ;; 11in in 0.1mm
    (call $gs16 (i32.add (local.get $devmode) (i32.const 82)) (i32.const 2159)) ;; 8.5in
    (call $gs16 (i32.add (local.get $devmode) (i32.const 86)) (i32.const 1))    ;; copies
    (call $gs16 (i32.add (local.get $devmode) (i32.const 90)) (i32.const 300))  ;; quality
    ;; DEVNAMES: 8-byte header, then the strings. The offsets are in
    ;; characters, so byte 8 is character 4 here rather than character 8.
    (local.set $devnames (call $heap_alloc (i32.const 64)))
    (local.set $dn_w (call $g2w (local.get $devnames)))
    (memory.fill (local.get $dn_w) (i32.const 0) (i32.const 64))
    (call $gs16 (local.get $devnames) (i32.const 4))                              ;; wDriverOffset
    (call $gs16 (i32.add (local.get $devnames) (i32.const 2)) (i32.const 13))     ;; wDeviceOffset
    (call $gs16 (i32.add (local.get $devnames) (i32.const 4)) (i32.const 25))     ;; wOutputOffset
    (call $gs16 (i32.add (local.get $devnames) (i32.const 6)) (i32.const 0))      ;; wDefault
    (call $memcpy (i32.add (local.get $dn_w) (i32.const 8)) (i32.const 0x11220) (i32.const 8))
    (call $acm_widen_in_place (i32.add (local.get $devnames) (i32.const 8)) (i32.const 8))
    (call $memcpy (i32.add (local.get $dn_w) (i32.const 26)) (i32.const 0x11229) (i32.const 11))
    (call $acm_widen_in_place (i32.add (local.get $devnames) (i32.const 26)) (i32.const 11))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 8)) (local.get $devmode))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 12)) (local.get $devnames))
    (global.set $printer_hdc (call $gdi_printer_dc_alloc))
    (call $gs32 (i32.add (local.get $arg0) (i32.const 16)) (global.get $printer_hdc))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 24)) (i32.const 1))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 26)) (i32.const 1))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 28)) (i32.const 1))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 30)) (i32.const 9999))
    (call $gs16 (i32.add (local.get $arg0) (i32.const 32)) (i32.const 1))
    (if (i32.and (local.get $flags) (i32.const 0x00000400))   ;; PD_RETURNDEFAULT
      (then
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (global.set $common_dialog_kind (i32.const 2))
    (global.set $common_dialog_struct (local.get $arg0))
    (call $create_print_dialog (local.get $dlg) (local.get $owner))
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
    (local $rc i32) (local $desc i32)
    (local.set $rc (call $g2w (local.get $arg1)))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (call $gdi_surface_descriptor (local.get $arg0) (local.get $desc))
      (then (global.set $eax (call $gdi_draw_edge_desc
        (local.get $arg0) (local.get $desc)
        (i32.load (local.get $rc)) (i32.load offset=4 (local.get $rc))
        (i32.load offset=8 (local.get $rc)) (i32.load offset=12 (local.get $rc))
        (i32.const 5) (i32.const 15) (local.get $rc))))
      (else (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

;; 948: RegEnumKeyA(hKey, dwIndex, lpName, cchName) — 4 args stdcall
  (func $handle_RegEnumKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_reg_enum_key
      (local.get $arg0)                    ;; hKey
      (local.get $arg1)                    ;; dwIndex
      (local.get $arg2)                    ;; lpName guest pointer
      (local.get $arg3)                    ;; cchName
      (i32.const 0)))                      ;; isWide = false
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; RegEnumValueA/W have eight arguments; args 5-7 are loaded from the guest stack.
  (func $handle_RegEnumValueA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (global.set $eax (call $host_reg_enum_value
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)
      (i32.load offset=24 (local.get $wa_esp))
      (i32.load offset=28 (local.get $wa_esp))
      (i32.load offset=32 (local.get $wa_esp))
      (i32.const 0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))))

  (func $handle_RegEnumValueW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (global.set $eax (call $host_reg_enum_value
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)
      (i32.load offset=24 (local.get $wa_esp))
      (i32.load offset=28 (local.get $wa_esp))
      (i32.load offset=32 (local.get $wa_esp))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))))

  (func $handle_RegQueryInfoKeyA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (global.set $eax (call $host_reg_query_info
      (local.get $arg0)
      (local.get $arg4)
      (i32.load offset=24 (local.get $wa_esp))
      (i32.load offset=32 (local.get $wa_esp))
      (i32.load offset=36 (local.get $wa_esp))
      (i32.load offset=40 (local.get $wa_esp))
      (i32.const 0)))
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (i32.const 0))))
    (if (i32.load offset=28 (local.get $wa_esp))
      (then (call $gs32 (i32.load offset=28 (local.get $wa_esp)) (i32.const 0))))
    (if (i32.load offset=44 (local.get $wa_esp))
      (then (call $gs32 (i32.load offset=44 (local.get $wa_esp)) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52))))

  (func $handle_RegQueryInfoKeyW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (global.set $eax (call $host_reg_query_info
      (local.get $arg0)
      (local.get $arg4)
      (i32.load offset=24 (local.get $wa_esp))
      (i32.load offset=32 (local.get $wa_esp))
      (i32.load offset=36 (local.get $wa_esp))
      (i32.load offset=40 (local.get $wa_esp))
      (i32.const 1)))
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (i32.const 0))))
    (if (i32.load offset=28 (local.get $wa_esp))
      (then (call $gs32 (i32.load offset=28 (local.get $wa_esp)) (i32.const 0))))
    (if (i32.load offset=44 (local.get $wa_esp))
      (then (call $gs32 (i32.load offset=44 (local.get $wa_esp)) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52))))

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

  ;; CreateIcon(hInst, nWidth, nHeight, cPlanes, cBitsPixel, lpbANDbits, lpbXORbits)
  ;; — 7 args stdcall. Same opaque-handle model the rest of the icon APIs use:
  ;; GetIconInfo reports no bitmaps and DrawIconEx is a no-op, so keeping the
  ;; AND/XOR masks would give nothing anything to read them. Returning a handle
  ;; from the same space keeps DestroyIcon and CopyImage consistent.
  (func $handle_CreateIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x00CC0001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; ret + 7 args
  )

  ;; 944: DrawIconEx(hdc, x, y, hIcon, cx, cy, istep, hbrFlicker, diFlags) — 9 args stdcall
  ;; Only the first five arguments arrive as parameters; the rest are still on
  ;; the guest stack above the return address.
  (func $handle_DrawIconEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $flags i32)
    (local.set $flags (i32.load (call $g2w
      (i32.add (global.get $esp) (i32.const 36)))))  ;; ret + 8 args
    (drop (call $icon_draw_handle
      (local.get $arg3) (local.get $arg0)
      (local.get $arg1) (local.get $arg2)
      (local.get $arg4)
      (i32.load (call $g2w (i32.add (global.get $esp) (i32.const 24))))
      (local.get $flags)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 40)))  ;; 9 args + ret
  )

  ;; DrawIcon(hdc, x, y, hIcon) — 4 args stdcall. The fixed-size sibling of
  ;; DrawIconEx: always the icon's natural size, always the full composite.
  (func $handle_DrawIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (drop (call $icon_draw_handle
      (local.get $arg3) (local.get $arg0)
      (local.get $arg1) (local.get $arg2)
      (i32.const 0) (i32.const 0) (global.get $DI_NORMAL)))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))  ;; ret + 4 args
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
    (call $modal_capture_nonvolatile)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (local.set $owner (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
    (call $create_color_dialog (local.get $dlg) (local.get $owner) (local.get $arg0))
    (call $modal_begin (local.get $dlg) (i32.const 8)))

  ;; ChooseColorW / PageSetupDlgW — CHOOSECOLOR and PAGESETUPDLG have the same
  ;; layout in both flavours, and the only members that differ are the template
  ;; name pointers, which neither implementation reads. So these are the same
  ;; call, not a reimplementation.
  ;;
  ;; They are worth registering rather than leaving absent because NT Paint
  ;; delay-loads them: a failed GetProcAddress does not come back as an error,
  ;; it raises 0xC06D007F and takes the process down. Options > Edit Colors...
  ;; and File > Page Setup... each killed Paint outright.
  (func $handle_ChooseColorW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_ChooseColorA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  (func $handle_PageSetupDlgW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_PageSetupDlgA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr)))

  ;; === VERSION.DLL APIs ===

  ;; GetFileVersionInfoSizeA(lptstrFilename, lpdwHandle) → size or 0
  ;; Finds RT_VERSION (16) resource ID 1 in the loaded PE and returns its size.
  (func $handle_GetFileVersionInfoSizeA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $size i32)
    ;; If lpdwHandle is non-null, set *lpdwHandle = 0
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0))))
    ;; Find RT_VERSION (16) resource with ID 1
    (local.set $entry (call $find_resource (i32.const 16) (i32.const 1)))
    (if (local.get $entry)
      (then
        ;; entry points to data entry: +0=RVA, +4=size
        (local.set $size (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $entry) (i32.const 4)))))
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
    (local.set $rva (call $gl32 (i32.add (global.get $image_base) (local.get $entry))))
    (local.set $size (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $entry) (i32.const 4)))))
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
        (call $gs32 (local.get $arg2)
          (i32.add (local.get $arg0) (i32.const 0x28)))
        ;; Set *puLen = sizeof(VS_FIXEDFILEINFO) = 52
        (call $gs32 (local.get $arg3) (i32.const 52))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    ;; For any other sub-block or if signature doesn't match, return FALSE
    (if (local.get $arg3)
      (then (call $gs32 (local.get $arg3) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

 GetWindowTextLengthA(hwnd) → length in chars (no NUL).
  (func $handle_GetWindowTextLengthA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $ctrl_table_get_class (local.get $arg0))
      (then
        (global.set $eax
          (call $control_wndproc_dispatch
            (local.get $arg0) (i32.const 0x000E)
            (i32.const 0) (i32.const 0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (global.set $eax (call $host_get_window_text_length (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; ret + 1 arg
  )

  (func $handle_GetCharWidth32W (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_font_char_widths
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (if (result i32) (local.get $arg3)
        (then (call $g2w (local.get $arg3))) (else (i32.const 0)))
      (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_GetCharacterPlacementW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $gdi_character_placement_w
      (local.get $arg0)
      (if (result i32) (local.get $arg1)
        (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2) (local.get $arg3)
      (if (result i32) (local.get $arg4)
        (then (call $g2w (local.get $arg4))) (else (i32.const 0)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

