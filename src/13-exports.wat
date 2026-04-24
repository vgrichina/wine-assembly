  ;; ============================================================
  ;; MAIN RUN LOOP
  ;; ============================================================
  (func $run (export "run") (param $max_blocks i32)
    (local $thread i32) (local $blocks i32)
    (local $hc_i i32) (local $hc_slot i32)
    (local $prev_eip i32) (local $prev_esp i32)
    (local.set $blocks (local.get $max_blocks))
    (block $halt (loop $main
      (br_if $halt (i32.le_s (local.get $blocks) (i32.const 0)))
      (br_if $halt (i32.eqz (global.get $eip)))
      (local.set $blocks (i32.sub (local.get $blocks) (i32.const 1)))
      ;; Reset thread buffer if approaching cache region (leave 4KB margin)
      (if (i32.ge_u (global.get $thread_alloc) (i32.sub (global.get $CACHE_INDEX) (i32.const 4096)))
        (then
          (global.set $thread_alloc (global.get $THREAD_BASE))
          (call $clear_cache)))
      ;; Watchpoint: break when watched region (1/2/4 bytes) changes
      (if (global.get $watch_addr)
        (then
          (if (i32.ne (call $watch_load (global.get $watch_addr)) (global.get $watch_val))
            (then
              (global.set $watch_val (call $watch_load (global.get $watch_addr)))
              (br $halt)))))
      ;; Yield flag — host needs control (e.g. after WM_TIMER delivery)
      (if (global.get $yield_flag)
        (then
          (global.set $yield_flag (i32.const 0))
          (br $halt)))
      ;; EIP breakpoint. On halt we set $bp_skip_once so re-entry (same $eip)
      ;; dispatches the block once before the bp can fire again — without this,
      ;; JS-driven re-arm (e.g. --trace-at) spins halting at the same address.
      (if (i32.eq (global.get $eip) (global.get $bp_addr))
        (then
          (if (global.get $bp_skip_once)
            (then (global.set $bp_skip_once (i32.const 0)))
            (else (global.set $bp_skip_once (i32.const 1)) (br $halt)))))
      ;; EIP hit counters (passive): increment count for any slot whose addr==eip.
      ;; Early-out via $hit_count_n (0 when no --count= flags active).
      (if (global.get $hit_count_n)
        (then
          (local.set $hc_i (i32.const 0))
          (block $hc_done (loop $hc_loop
            (br_if $hc_done (i32.ge_u (local.get $hc_i) (global.get $hit_count_n)))
            (local.set $hc_slot (i32.add (global.get $HIT_COUNT_BASE)
                                         (i32.shl (local.get $hc_i) (i32.const 3))))
            (if (i32.eq (i32.load (local.get $hc_slot)) (global.get $eip))
              (then
                (i32.store offset=4 (local.get $hc_slot)
                  (i32.add (i32.load offset=4 (local.get $hc_slot)) (i32.const 1)))))
            (local.set $hc_i (i32.add (local.get $hc_i) (i32.const 1)))
            (br $hc_loop))))
        )
      ;; Exit if WaitForSingleObject yielded (yield_reason=1)
      (br_if $halt (i32.eq (global.get $yield_reason) (i32.const 1)))
      ;; If EIP landed in thunk zone (e.g. ret-to-thunk for sync message continuation),
      ;; dispatch the thunk directly instead of trying to decode it as x86
      (if (i32.and (i32.ge_u (global.get $eip) (global.get $thunk_guest_base))
                   (i32.lt_u (global.get $eip) (global.get $thunk_guest_end)))
        (then
          (local.set $prev_eip (global.get $eip))
          (local.set $prev_esp (global.get $esp))
          (global.set $handler_set_eip (i32.const 0))
          (call $win32_dispatch (i32.div_u
            (i32.sub (global.get $eip) (global.get $thunk_guest_base)) (i32.const 8)))
          ;; If handler didn't redirect EIP, pop the saved return address.
          ;; Normal API handlers do `esp += 4 + nargs*4` but never set EIP;
          ;; without this, re-entry to the same thunk loops forever and
          ;; bleeds ESP by the handler's pop each pass. Continuation thunks
          ;; (CACA*) that deliberately re-enter by setting EIP to the same
          ;; thunk addr raise $handler_set_eip to opt out of the auto-pop.
          (if (i32.and
                (i32.eq (global.get $eip) (local.get $prev_eip))
                (i32.eqz (global.get $handler_set_eip)))
            (then (global.set $eip (call $gl32 (local.get $prev_esp)))))
          (br $main)))
      ;; DEBUG: count entries into the wall-error call site (was diagnosing FUCOMPP bug)
      (if (i32.eq (global.get $eip) (i32.const 0x01009604))
        (then
          (call $host_log_i32 (i32.const 0xDEC0DE19))
          (call $host_log_i32 (global.get $eax))
          (call $host_log_i32 (call $gl32 (i32.add (global.get $edi) (i32.const 8))))))
      (global.set $dbg_prev_eip (global.get $eip))
      ;; --trace-esp: emit (eip, esp) at block entry for in-range EIPs.
      (if (global.get $trace_esp_flag)
        (then
          (if (i32.and
                (i32.ge_u (global.get $eip) (global.get $trace_esp_lo))
                (i32.or (i32.eqz (global.get $trace_esp_hi))
                        (i32.le_u (global.get $eip) (global.get $trace_esp_hi))))
            (then (call $host_log_block (global.get $eip) (global.get $esp))))))
      (local.set $thread (call $cache_lookup (global.get $eip)))
      (if (i32.eqz (local.get $thread))
        (then (local.set $thread (call $decode_block (global.get $eip)))))
      (global.set $ip (local.get $thread))
      ;; Set steps high enough to always complete a block
      (global.set $steps (i32.const 1000))
      (call $next)
      (br $main))))

  ;; ============================================================
  ;; DEBUG EXPORTS
  ;; ============================================================
  (func (export "get_eip") (result i32) (global.get $eip))
  (func (export "get_dbg_prev_eip") (result i32) (global.get $dbg_prev_eip))
  (func (export "get_esp") (result i32) (global.get $esp))
  (func (export "get_eax") (result i32) (global.get $eax))
  (func (export "get_ecx") (result i32) (global.get $ecx))
  (func (export "get_edx") (result i32) (global.get $edx))
  (func (export "get_ebx") (result i32) (global.get $ebx))
  (func (export "get_ebp") (result i32) (global.get $ebp))
  (func (export "get_esi") (result i32) (global.get $esi))
  (func (export "get_edi") (result i32) (global.get $edi))
  (func (export "get_staging") (result i32) (global.get $PE_STAGING))
  (func (export "get_fs_base") (result i32) (global.get $fs_base))
  (func (export "get_image_base") (result i32) (global.get $image_base))
  (func (export "get_thread_alloc") (result i32) (global.get $thread_alloc))
  (func (export "get_wndproc") (result i32) (global.get $wndproc_addr))
  (func (export "get_thunk_base") (result i32) (global.get $thunk_guest_base))
  (func (export "get_thunk_end") (result i32) (global.get $thunk_guest_end))
  (func (export "get_num_thunks") (result i32) (global.get $num_thunks))
  ;; Update thunk end to match current allocation count
  (func $update_thunk_end (export "seal_thunks")
    (global.set $thunk_guest_end
      (i32.add (global.get $thunk_guest_base)
        (i32.mul (global.get $num_thunks) (i32.const 8)))))

  ;; Flag debugging exports
  (func (export "get_flag_res") (result i32) (global.get $flag_res))
  (func (export "get_flag_op") (result i32) (global.get $flag_op))
  (func (export "get_flag_a") (result i32) (global.get $flag_a))
  (func (export "get_flag_b") (result i32) (global.get $flag_b))
  (func (export "get_flag_sign_shift") (result i32) (global.get $flag_sign_shift))

  (func (export "get_heap_ptr") (result i32) (global.get $heap_ptr))
  (func (export "set_heap_ptr") (param i32) (global.set $heap_ptr (local.get 0)))
  (func (export "get_heap_base") (result i32) (global.get $heap_base))
  ;; Post queue exports for IPC injection
  (func (export "get_main_hwnd") (result i32) (global.get $main_hwnd))
  (func (export "get_dx_primary_pal_wa") (result i32) (global.get $dx_primary_pal_wa))
  (func (export "get_flash_state") (param $hwnd i32) (result i32)
    (local $slot i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (result i32) (i32.eq (local.get $slot) (i32.const -1))
      (then (i32.const 0))
      (else (i32.load8_u (i32.add (global.get $FLASH_TABLE) (local.get $slot))))))
  (func (export "get_post_queue_count") (result i32) (global.get $post_queue_count))
  (func (export "set_post_queue_count") (param i32) (global.set $post_queue_count (local.get 0)))
  (func (export "wnd_table_set") (param i32) (param i32) (call $wnd_table_set (local.get 0) (local.get 1)))

  ;; ---- NC/message plumbing exports (JS host posts messages into WAT's queues) ----
  (func (export "nc_post_paint") (param $hwnd i32)
    (call $nc_flags_set (local.get $hwnd) (i32.const 1)))   ;; bit 0
  (func (export "nc_post_erase") (param $hwnd i32)
    (call $nc_flags_set (local.get $hwnd) (i32.const 2)))   ;; bit 1
  (func (export "nc_post_calcsize") (param $hwnd i32)
    (call $nc_flags_set (local.get $hwnd) (i32.const 4)))   ;; bit 2
  (func (export "nc_flags_test") (param $hwnd i32) (result i32)
    (call $nc_flags_test (local.get $hwnd)))
  (func (export "post_message_q")
        (param $hwnd i32) (param $msg i32) (param $wP i32) (param $lP i32) (result i32)
    (call $post_queue_push (local.get $hwnd) (local.get $msg) (local.get $wP) (local.get $lP)))
  ;; User-initiated resize commit (host mousedrag on edge/corner or SC_MAXIMIZE).
  ;; Renderer has already updated win.{x,y,w,h}; we recompute CLIENT_RECT
  ;; and post WM_MOVE + WM_SIZE so the guest wndproc relays out.
  (func (export "host_resize_commit")
        (param $hwnd i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32)
    (local $cw i32) (local $ch i32)
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    (local.set $cw (i32.sub (call $client_rect_get_r (local.get $hwnd))
                             (call $client_rect_get_l (local.get $hwnd))))
    (local.set $ch (i32.sub (call $client_rect_get_b (local.get $hwnd))
                             (call $client_rect_get_t (local.get $hwnd))))
    (if (i32.lt_s (local.get $cw) (i32.const 0)) (then (local.set $cw (i32.const 0))))
    (if (i32.lt_s (local.get $ch) (i32.const 0)) (then (local.set $ch (i32.const 0))))
    (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0003) ;; WM_MOVE
      (i32.const 0)
      (i32.or (i32.and (local.get $x) (i32.const 0xFFFF))
              (i32.shl (local.get $y) (i32.const 16)))))
    (drop (call $post_queue_push (local.get $hwnd) (i32.const 0x0005) ;; WM_SIZE
      (i32.const 0) ;; SIZE_RESTORED
      (i32.or (i32.and (local.get $cw) (i32.const 0xFFFF))
              (i32.shl (local.get $ch) (i32.const 16))))))
  ;; Cursor state readback — for tests / JS to verify SetCursor plumbing.
  (func (export "get_cursor") (result i32) (global.get $current_cursor))
  ;; Synchronous NCHITTEST helper — JS calls before generating mouse
  ;; events so classification lives in WAT. Returns HT* code.
  (func (export "hittest_sync")
        (param $hwnd i32) (param $sx i32) (param $sy i32) (result i32)
    (call $defwndproc_do_nchittest (local.get $hwnd) (local.get $sx) (local.get $sy)))
  ;; Client rect (window-local) written by WM_NCCALCSIZE; read by JS drawWindow.
  (func (export "get_client_rect_l") (param $hwnd i32) (result i32) (call $client_rect_get_l (local.get $hwnd)))
  (func (export "get_client_rect_t") (param $hwnd i32) (result i32) (call $client_rect_get_t (local.get $hwnd)))
  (func (export "get_client_rect_r") (param $hwnd i32) (result i32) (call $client_rect_get_r (local.get $hwnd)))
  (func (export "get_client_rect_b") (param $hwnd i32) (result i32) (call $client_rect_get_b (local.get $hwnd)))
  ;; Packed client width|height (low 16 | high 16) — convenience for host_imports.
  (func (export "get_client_rect_wh") (param $hwnd i32) (result i32)
    (i32.or
      (i32.and
        (i32.sub (call $client_rect_get_r (local.get $hwnd)) (call $client_rect_get_l (local.get $hwnd)))
        (i32.const 0xFFFF))
      (i32.shl
        (i32.sub (call $client_rect_get_b (local.get $hwnd)) (call $client_rect_get_t (local.get $hwnd)))
        (i32.const 16))))
  ;; Title storage — JS writes via set_window_title_wa; DefWindowProc reads during NCPAINT.
  (func (export "set_window_title_wa") (param $hwnd i32) (param $wa_ptr i32) (param $len i32)
    (call $title_table_set (local.get $hwnd) (local.get $wa_ptr) (local.get $len)))
  (func (export "get_window_title_ptr") (param $hwnd i32) (result i32)
    (call $title_table_get_ptr (local.get $hwnd)))
  (func (export "get_window_title_len") (param $hwnd i32) (result i32)
    (call $title_table_get_len (local.get $hwnd)))

  ;; Thread init — called by host after creating worker instance
  (func (export "init_thread") (param $tid i32)
      (param $img_base i32) (param $code_s i32) (param $code_e i32)
      (param $thunk_gs i32) (param $thunk_ge i32) (param $num_th i32)
    (global.set $THREAD_BASE (i32.add (i32.const 0x03E52000)
      (i32.mul (local.get $tid) (i32.const 0x80000))))
    (global.set $CACHE_INDEX (i32.add (i32.const 0x04252000)
      (i32.mul (local.get $tid) (i32.const 0x8000))))
    (global.set $thread_alloc (global.get $THREAD_BASE))
    (global.set $image_base (local.get $img_base))
    (global.set $code_start (local.get $code_s))
    (global.set $code_end (local.get $code_e))
    (global.set $thunk_guest_base (local.get $thunk_gs))
    (global.set $thunk_guest_end (local.get $thunk_ge))
    (global.set $num_thunks (local.get $num_th))
  )

  ;; Yield state exports
  (func (export "get_yield_reason") (result i32) (global.get $yield_reason))
  (func (export "get_wait_handle") (result i32) (global.get $wait_handle))
  (func (export "get_wait_handles_ptr") (result i32) (global.get $wait_handles_ptr))
  (func (export "clear_yield") (global.set $yield_reason (i32.const 0)) (global.set $wait_handles_ptr (i32.const 0)))
  (func (export "get_sync_table") (result i32) (global.get $SYNC_TABLE))
  (func (export "get_yield_flag") (result i32) (global.get $yield_flag))
  (func (export "get_sleep_yielded") (result i32)
    (local $v i32)
    (local.set $v (global.get $sleep_yielded))
    (global.set $sleep_yielded (i32.const 0))
    (local.get $v))
  (func (export "get_com_dll_name") (result i32) (global.get $com_dll_name))
  (func (export "get_loadlib_name") (result i32) (global.get $loadlib_name_ptr))

  ;; PE metadata exports (needed to init worker threads)
  (func (export "get_code_start") (result i32) (global.get $code_start))
  (func (export "get_code_end") (result i32) (global.get $code_end))
  (func (export "get_main_win_cx") (result i32) (global.get $main_win_cx))
  (func (export "get_main_win_cy") (result i32) (global.get $main_win_cy))

  ;; Register setters for test harness
  (func (export "set_eip") (param i32) (global.set $eip (local.get 0)))
  (func (export "set_esp") (param i32) (global.set $esp (local.get 0)))
  (func (export "set_ebp") (param i32) (global.set $ebp (local.get 0)))
  (func (export "set_eax") (param i32) (global.set $eax (local.get 0)))
  (func (export "set_ecx") (param i32) (global.set $ecx (local.get 0)))
  (func (export "set_edx") (param i32) (global.set $edx (local.get 0)))
  (func (export "set_ebx") (param i32) (global.set $ebx (local.get 0)))
  (func (export "set_esi") (param i32) (global.set $esi (local.get 0)))
  (func (export "set_edi") (param i32) (global.set $edi (local.get 0)))

  ;; Windows version
  (func (export "set_winver") (param i32) (global.set $winver (local.get 0)))
  (func (export "get_winver") (result i32) (global.get $winver))

  ;; Multi-app hwnd allocation — set base hwnd before PE load
  (func (export "set_hwnd_base") (param i32) (global.set $next_hwnd (local.get 0)))
  (func (export "get_hwnd_base") (result i32) (global.get $next_hwnd))

  ;; Watchpoint exports
  (func (export "set_bp") (param $addr i32) (global.set $bp_addr (local.get $addr)))
  (func (export "clear_bp") (global.set $bp_addr (i32.const 0)))

  ;; --trace-esp wiring (test harness uses this). Pass hi=0 to disable the
  ;; upper bound; pass flag=0 to turn off tracing.
  (func (export "set_trace_esp") (param $flag i32) (param $lo i32) (param $hi i32)
    (global.set $trace_esp_flag (local.get $flag))
    (global.set $trace_esp_lo (local.get $lo))
    (global.set $trace_esp_hi (local.get $hi)))

  ;; Hit counters: set_count writes addr into slot N and zeros its count,
  ;; bumping $hit_count_n so the run loop includes this slot. Caller passes
  ;; slots 0..N-1 in order (contiguous); $hit_count_n = max(slot+1).
  (func (export "set_count") (param $slot i32) (param $addr i32)
    (local $base i32)
    (local.set $base (i32.add (global.get $HIT_COUNT_BASE)
                              (i32.shl (local.get $slot) (i32.const 3))))
    (i32.store          (local.get $base) (local.get $addr))
    (i32.store offset=4 (local.get $base) (i32.const 0))
    (if (i32.gt_s (i32.add (local.get $slot) (i32.const 1)) (global.get $hit_count_n))
      (then (global.set $hit_count_n (i32.add (local.get $slot) (i32.const 1))))))
  (func (export "get_count") (param $slot i32) (result i32)
    (i32.load offset=4 (i32.add (global.get $HIT_COUNT_BASE)
                                (i32.shl (local.get $slot) (i32.const 3)))))
  (func (export "clear_counts") (global.set $hit_count_n (i32.const 0)))
  ;; Size-aware load for watchpoint. $watch_size: 1=byte, 2=word, anything else=dword.
  (func $watch_load (param $addr i32) (result i32)
    (if (result i32) (i32.eq (global.get $watch_size) (i32.const 1))
      (then (call $gl8 (local.get $addr)))
      (else (if (result i32) (i32.eq (global.get $watch_size) (i32.const 2))
        (then (call $gl16 (local.get $addr)))
        (else (call $gl32 (local.get $addr)))))))
  (func (export "set_watchpoint") (param $addr i32)
    (global.set $watch_addr (local.get $addr))
    (if (local.get $addr)
      (then (global.set $watch_val (call $watch_load (local.get $addr))))
      (else (global.set $watch_val (i32.const 0)))))
  (func (export "set_watchpoint_size") (param $size i32)
    (global.set $watch_size (local.get $size))
    ;; re-read current value with new size so caller sees consistent baseline
    (if (global.get $watch_addr)
      (then (global.set $watch_val (call $watch_load (global.get $watch_addr))))))
  (func (export "get_watch_val") (result i32) (global.get $watch_val))
  (func (export "get_watch_addr") (result i32) (global.get $watch_addr))
  (func (export "get_watch_size") (result i32) (global.get $watch_size))

  ;; call_func(addr, arg0, arg1, arg2, arg3): push args right-to-left + halt
  ;; return addr, set EIP, then caller uses run() to execute. Result in EAX.
  (func (export "call_func") (param $addr i32) (param $a0 i32) (param $a1 i32) (param $a2 i32) (param $a3 i32)
    ;; Push args right-to-left (stdcall/cdecl convention)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a3))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a2))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a1))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a0))
    ;; Push return address = 0 (will halt when RET tries to jump to 0)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))
    ;; Set EIP to function address
    (global.set $eip (local.get $addr))
  )

  ;; fire_mm_timer: check if multimedia timer is due, inject callback if so.
  ;; Saves current EIP as return address so execution resumes after callback returns.
  ;; Returns 1 if timer was fired, 0 if not due or no timer active.
  (func (export "fire_mm_timer") (result i32)
    (local $elapsed i32)
    (if (i32.eqz (global.get $mm_timer_id)) (then (return (i32.const 0))))
    ;; Re-entrancy guard: if callback is running, check if it returned
    (if (global.get $mm_timer_in_cb) (then
      (if (i32.ge_u (global.get $esp) (global.get $mm_timer_saved_esp))
        (then (global.set $mm_timer_in_cb (i32.const 0)))  ;; callback returned
        (else (return (i32.const 0))))))                    ;; still running
    (global.set $tick_count (call $host_get_ticks))
    (local.set $elapsed (i32.sub (global.get $tick_count) (global.get $mm_timer_last_tick)))
    (if (i32.lt_u (local.get $elapsed) (global.get $mm_timer_interval))
      (then (return (i32.const 0))))
    ;; Timer is due — update last tick
    (global.set $mm_timer_last_tick (global.get $tick_count))
    (if (global.get $mm_timer_oneshot)
      (then (global.set $mm_timer_id (i32.const 0))))
    ;; Save ESP before pushing anything (re-entrancy guard compares against this)
    (global.set $mm_timer_saved_esp (global.get $esp))
    (global.set $mm_timer_in_cb (i32.const 1))
    ;; Save caller-saved regs + flags (36 bytes, includes EIP for restore)
    (call $save_caller_regs)
    ;; Push 5 args: dw2=0, dw1=0, dwUser, uMsg=0, uTimerID
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))                   ;; dw2
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))                   ;; dw1
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $mm_timer_dwuser))   ;; dwUser
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))                   ;; uMsg
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $mm_timer_id))       ;; uTimerID
    ;; Push return address = CACA000A thunk (restores regs when callback returns)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $mm_timer_ret_thunk))
    ;; Redirect EIP to callback
    (global.set $eip (global.get $mm_timer_callback))
    (i32.const 1))

  ;; Write guest memory (guest addr)
  (func (export "guest_write32") (param $ga i32) (param $val i32)
    (call $gs32 (local.get $ga) (local.get $val)))
  (func (export "guest_read32") (param $ga i32) (result i32)
    (call $gl32 (local.get $ga)))

  ;; Allocate guest heap memory (returns guest address)
  (func (export "guest_alloc") (param $size i32) (result i32)
    (call $heap_alloc (local.get $size)))
  (func (export "guest_free") (param $g i32)
    (call $heap_free (local.get $g)))

  ;; Write 16-bit value to guest memory
  (func (export "guest_write16") (param $ga i32) (param $val i32)
    (call $gs16 (local.get $ga) (local.get $val)))

  ;; Set EXE name — copies NUL-terminated string to 0x120 buffer (max 127 chars)
  (func (export "set_exe_name") (param $wa i32) (param $len i32)
    (local $i i32) (local $n i32)
    (local.set $n (if (result i32) (i32.gt_u (local.get $len) (i32.const 127))
      (then (i32.const 127)) (else (local.get $len))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store8 (i32.add (i32.const 0x120) (local.get $i))
        (i32.load8_u (i32.add (local.get $wa) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (i32.store8 (i32.add (i32.const 0x120) (local.get $n)) (i32.const 0))
    (global.set $exe_name_wa (i32.const 0x120))
    (global.set $exe_name_len (local.get $n)))

  ;; Get GUEST_BASE for direct WASM memory access
  (func (export "get_guest_base") (result i32) (global.get $GUEST_BASE))
  (func (export "get_dll_table") (result i32) (global.get $DLL_TABLE))

  ;; ============================================================
  ;; STEP 6 — WAT-side find/replace + edit-state inspection exports
  ;; ============================================================
  ;; The test bridge in test/run.js uses these to drive the parallel
  ;; WAT-side find dialog state created by $create_findreplace_dialog.
  (func (export "get_findreplace_dlg")  (result i32) (global.get $findreplace_dlg_hwnd))
  (func (export "get_findreplace_edit") (result i32) (global.get $findreplace_edit_hwnd))
  (func (export "wnd_get_userdata_export") (param $hwnd i32) (result i32)
    (call $wnd_get_userdata (local.get $hwnd)))

  ;; (No create_about_dialog export — $handle_ShellAboutA calls
  ;; $create_about_dialog directly from inside the WAT-side handler.
  ;; JS does not need to drive dialog construction.)
  (func (export "get_focus_hwnd")       (result i32) (global.get $focus_hwnd))
  (func (export "get_capture_hwnd")     (result i32) (global.get $capture_hwnd))
  (func (export "set_focus_hwnd")       (param i32)  (global.set $focus_hwnd (local.get 0)))

  ;; Count occupied WND_RECORDS slots (hwnd != 0). Used by the find dialog
  ;; cancel/leak regression test to verify $wnd_destroy_tree actually
  ;; releases child slots rather than letting them accumulate.
  (func (export "wnd_count_used") (result i32)
    (local $i i32) (local $n i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (if (i32.load (call $wnd_record_addr (local.get $i)))
        (then (local.set $n (i32.add (local.get $n) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $n))

  ;; Generic SendMessage entry point. Routes through $wnd_send_message:
  ;; WAT-native targets dispatch synchronously via $wat_wndproc_dispatch;
  ;; x86 targets queue via post_queue (PostMessage semantics, return 0).
  (func (export "send_message")
    (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32)
    (result i32)
    (call $wnd_send_message (local.get $hwnd) (local.get $msg)
                            (local.get $wParam) (local.get $lParam)))

  ;; Send WM_CHAR to the currently-focused hwnd. Returns 1 if dispatched.
  (func (export "send_char_to_focus") (param $code i32) (result i32)
    (if (i32.eqz (global.get $focus_hwnd)) (then (return (i32.const 0))))
    (drop (call $wnd_send_message
            (global.get $focus_hwnd)
            (i32.const 0x0102)  ;; WM_CHAR
            (local.get $code)
            (i32.const 0)))
    (i32.const 1))

  ;; Read the EditState text for an EDIT-class hwnd into a guest buffer.
  ;; Returns chars copied (excluding NUL); 0 if no state or empty buffer.
  ;; Caller is responsible for the destination buffer; we NUL-terminate.
  (func (export "get_edit_text")
    (param $hwnd i32) (param $dest_guest i32) (param $max i32) (result i32)
    (local $state i32) (local $state_w i32) (local $len i32) (local $src i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $state_w (call $g2w (local.get $state)))
    (local.set $len (i32.load offset=4 (local.get $state_w)))
    (local.set $src (i32.load (local.get $state_w)))
    (if (i32.le_u (local.get $max) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $len) (local.get $max))
      (then (local.set $len (i32.sub (local.get $max) (i32.const 1)))))
    (if (local.get $src)
      (then (if (local.get $len)
              (then (call $memcpy (call $g2w (local.get $dest_guest))
                                  (call $g2w (local.get $src))
                                  (local.get $len))))))
    (i32.store8 (i32.add (call $g2w (local.get $dest_guest)) (local.get $len)) (i32.const 0))
    (local.get $len))

  ;; EditState cursor position (offset+12).
  (func (export "get_edit_cursor") (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (i32.load offset=12 (call $g2w (local.get $s))))

  ;; EditState selection anchor (offset+16).
  (func (export "get_edit_sel_start") (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (i32.load offset=16 (call $g2w (local.get $s))))

  ;; EditState text length (offset+4).
  (func (export "get_edit_text_len") (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (i32.load offset=4 (call $g2w (local.get $s))))

  ;; ============================================================
  ;; Child-window enumeration + control read-back exports
  ;; ============================================================
  ;; Used by the renderer to draw WAT-managed children without needing
  ;; a parallel JS-side `controls[]` array.

  ;; Find next child slot of $parent at or after $start. Returns -1 when
  ;; no more children exist. Caller iterates: slot=0; while ((slot=next(p,slot))!=-1) { ... slot++; }
  (func (export "wnd_next_child_slot") (param $parent i32) (param $start i32) (result i32)
    (call $wnd_next_child_slot (local.get $parent) (local.get $start)))

  (func (export "wnd_slot_hwnd") (param $slot i32) (result i32)
    (call $wnd_slot_hwnd (local.get $slot)))

  ;; Get the parent hwnd of a window (0 if none).
  (func (export "wnd_get_parent") (param $hwnd i32) (result i32)
    (call $wnd_get_parent (local.get $hwnd)))

  ;; Geometry getters: each returns x|y<<16 or w|h<<16 (i16 each).
  (func (export "ctrl_get_xy") (param $hwnd i32) (result i32)
    (call $ctrl_get_xy_packed (local.get $hwnd)))
  (func (export "ctrl_get_wh") (param $hwnd i32) (result i32)
    (call $ctrl_get_wh_packed (local.get $hwnd)))

  ;; Update geometry for a control (used by renderer to sync JS dimensions → WAT).
  (func (export "ctrl_set_geom") (param $hwnd i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then (call $ctrl_geom_set (local.get $idx)
              (local.get $x) (local.get $y) (local.get $w) (local.get $h)))))

  ;; Control class (1=Button, 2=Edit, 3=Static; 0 if not a control).
  (func (export "ctrl_get_class") (param $hwnd i32) (result i32)
    (call $ctrl_table_get_class (local.get $hwnd)))

  ;; --- Dialog record readers ---
  ;; The JS renderer reads dialog header fields from WND_DLG_RECORDS
  ;; after WAT populates them in $dlg_load. Everything is keyed by the
  ;; dialog HWND. x/y/cx/cy are raw dialog units (DLUs) from the template —
  ;; the renderer multiplies by dluX/dluY to convert to pixels.
  (func (export "dlg_get_style") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load offset=4 (local.get $rec)))
  (func (export "dlg_get_ex_style") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load offset=8 (local.get $rec)))
  (func (export "dlg_get_x") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load16_s offset=12 (local.get $rec)))
  (func (export "dlg_get_y") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load16_s offset=14 (local.get $rec)))
  (func (export "dlg_get_cx") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load16_s offset=16 (local.get $rec)))
  (func (export "dlg_get_cy") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load16_s offset=18 (local.get $rec)))
  ;; Returns the WASM linear address of the dialog's ASCII title string,
  ;; or 0 if the template has no title. The guest heap is in linear
  ;; memory so $g2w is the JS-facing form.
  (func (export "dlg_get_title_wa") (param $hwnd i32) (result i32)
    (local $rec i32) (local $gptr i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (local.set $gptr (i32.load offset=20 (local.get $rec)))
    (if (i32.eqz (local.get $gptr)) (then (return (i32.const 0))))
    (call $g2w (local.get $gptr)))
  ;; Menu field from the template: integer ordinal, or guest ptr to an
  ;; ASCII string if the template named the menu. 0 = no menu. The
  ;; WNDCLASS.lpszMenuName path already handles both encodings.
  (func (export "dlg_get_menu") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load offset=24 (local.get $rec)))
  ;; Generic resource data accessor. Finds (type, name_id_or_str) and
  ;; returns the WASM linear address of the data payload; the size
  ;; sits in a WAT global readable via rsrc_last_size. Used by
  ;; gdi_load_bitmap to pull RT_BITMAP bytes without a JS pre-parse.
  (func (export "rsrc_find_data_wa") (param $type_id i32) (param $name_id i32) (result i32)
    (call $rsrc_find_data_wa (local.get $type_id) (local.get $name_id)))
  (func (export "rsrc_last_size") (result i32)
    (global.get $rsrc_last_size))
  ;; Existence check for a resource by (type, int id or guest str ptr).
  ;; Used by the renderer to decide whether a window has a menu resource
  ;; without a JS-side presence map.
  (func (export "rsrc_exists") (param $type_id i32) (param $name_id i32) (result i32)
    (i32.ne (call $find_resource (local.get $type_id) (local.get $name_id)) (i32.const 0)))

  (func (export "dlg_get_ctrl_count") (param $hwnd i32) (result i32)
    (local $rec i32)
    (local.set $rec (call $dlg_record_for_hwnd (local.get $hwnd)))
    (if (i32.eqz (local.get $rec)) (then (return (i32.const 0))))
    (i32.load offset=28 (local.get $rec)))

  ;; Control id from CONTROL_TABLE.
  (func (export "ctrl_get_id") (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1)) (then (return (i32.const 0))))
    (i32.load offset=4
      (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16)))))

  ;; Window style (also exposed for renderer drawing decisions).
  (func (export "wnd_get_style_export") (param $hwnd i32) (result i32)
    (call $wnd_get_style (local.get $hwnd)))

  ;; ButtonState text reader (parallel to get_edit_text).
  (func (export "button_get_text")
    (param $hwnd i32) (param $dest_guest i32) (param $max i32) (result i32)
    (local $state i32) (local $sw i32) (local $len i32) (local $src i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $src (i32.load (local.get $sw)))
    (local.set $len (i32.load offset=4 (local.get $sw)))
    (if (i32.le_u (local.get $max) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $len) (local.get $max))
      (then (local.set $len (i32.sub (local.get $max) (i32.const 1)))))
    (if (local.get $src)
      (then (if (local.get $len)
              (then (call $memcpy (call $g2w (local.get $dest_guest))
                                  (call $g2w (local.get $src))
                                  (local.get $len))))))
    (i32.store8 (i32.add (call $g2w (local.get $dest_guest)) (local.get $len)) (i32.const 0))
    (local.get $len))

  ;; ButtonState flags: bit0=pressed bit1=checked bit2=default bit3=focused
  ;; bits 4..7 = button kind (0=push 1=checkbox 2=radio 3=groupbox).
  (func (export "button_get_flags") (param $hwnd i32) (result i32)
    (local $state i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (i32.load offset=8 (call $g2w (local.get $state))))

  ;; Wrapper around $wnd_destroy_tree for tests that need to tear down a
  ;; standalone dialog/control without going through find/about teardown.
  (func (export "wnd_destroy_tree") (param $hwnd i32)
    (call $wnd_destroy_tree (local.get $hwnd)))

  ;; Open dialog: re-populate the listbox after a file upload completes.
  ;; JS calls this from the <input type="file"> change handler once the
  ;; new file has been written into the VFS, so the listbox shows it.
  (func (export "opendlg_refresh_listbox") (param $dlg i32)
    (local $lb i32)
    (local.set $lb (call $ctrl_find_by_id (local.get $dlg) (i32.const 0x441)))
    (if (local.get $lb)
      (then (call $opendlg_populate_listbox (local.get $lb)
              (call $wat_str_to_heap (i32.const 0x20E) (i32.const 4))))))

  ;; Lookup the Nth basic color in the ChooseColor swatch grid. Used by
  ;; the renderer's class-6 draw branch so the grid can be painted
  ;; without duplicating the color table in JS.
  (func (export "colorgrid_color") (param $idx i32) (result i32)
    (call $colorgrid_color_for_idx (local.get $idx)))

  ;; Current selection for a colorgrid hwnd (reads ColorGridState[0]).
  (func (export "colorgrid_get_sel") (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const -1))))
    (i32.load (call $g2w (local.get $s))))

  ;; Test helper: build a Color dialog standalone (no x86 caller).
  (func (export "test_create_color_dialog") (result i32)
    (local $dlg i32) (local $cc i32)
    (local.set $cc (call $heap_alloc (i32.const 36)))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_color_dialog (local.get $dlg) (i32.const 0) (local.get $cc))
    (local.get $dlg))

  ;; Test helper: build a Font dialog standalone (no x86 caller). Needs
  ;; a fake CHOOSEFONT guest ptr with at minimum lpLogFont at +0x0C so
  ;; the IDOK handler doesn't NPE on write-back.
  (func (export "test_create_font_dialog") (result i32)
    (local $dlg i32) (local $cf i32) (local $lf i32)
    (local.set $cf (call $heap_alloc (i32.const 64)))
    (local.set $lf (call $heap_alloc (i32.const 60)))
    (i32.store offset=12 (call $g2w (local.get $cf)) (local.get $lf))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_font_dialog (local.get $dlg) (i32.const 0) (local.get $cf))
    (local.get $dlg))

  ;; Test helper: build an Open/Save dialog standalone (no x86 caller).
  ;; kind 0 = Open, 1 = Save As. Returns the dialog hwnd. Used by
  ;; scratch/render-open-dlg.js to render the dialog visually with
  ;; has_dom=1 so the upload/download button is included.
  (func (export "test_create_open_dialog") (param $kind i32) (result i32)
    (local $dlg i32)
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_open_dialog (local.get $dlg) (i32.const 0) (local.get $kind) (i32.const 0))
    (local.get $dlg))

  ;; Test helper: build a Find/Replace dialog standalone (no x86 caller).
  ;; FR struct guest ptr is allocated but unused by the dialog beyond
  ;; SetWindowLongPtr stash.
  (func (export "test_create_find_dialog") (result i32)
    (local $dlg i32) (local $fr i32)
    (local.set $fr (call $heap_alloc (i32.const 32)))
    (local.set $dlg (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $create_findreplace_dialog (local.get $dlg) (i32.const 0) (local.get $fr))
    (local.get $dlg))

  ;; Test helper: create a parent dlg + listbox child, return listbox hwnd.
  ;; The parent is registered as WNDPROC_CTRL_NATIVE with no class tag (so
  ;; control_wndproc_dispatch returns 0 = DefWindowProc) and exists only so
  ;; the listbox child has a real parent. Used by test/test-listbox.js.
  (func (export "test_create_listbox")
    (param $x i32) (param $y i32) (param $w i32) (param $h i32) (result i32)
    (local $parent i32) (local $lb i32)
    (local.set $parent (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $parent) (global.get $WNDPROC_CTRL_NATIVE))
    (drop (call $wnd_set_style (local.get $parent) (i32.const 0x80000000)))
    (local.set $lb (call $ctrl_create_child (local.get $parent) (i32.const 4) (i32.const 100)
                     (local.get $x) (local.get $y) (local.get $w) (local.get $h)
                     (i32.const 0x50000000) (i32.const 0)))
    (local.get $lb))

  ;; ListBoxState readers — used by lib/renderer.js to draw the visible
  ;; rows + selection highlight without round-tripping LB_GETTEXT for every
  ;; row. State layout in $listbox_wndproc.
  (func (export "listbox_get_count") (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (i32.load offset=12 (call $g2w (local.get $s))))
  (func (export "listbox_get_cur_sel") (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const -1))))
    (i32.load offset=16 (call $g2w (local.get $s))))
  (func (export "listbox_get_top_index") (param $hwnd i32) (result i32)
    (local $s i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (i32.load offset=20 (call $g2w (local.get $s))))
  ;; Copy item $idx text into $dest_guest (NUL-terminated). Returns chars
  ;; copied (excluding NUL), or 0 if out of range. Same shape as
  ;; get_edit_text / button_get_text so the renderer can use the same
  ;; readText helper.
  (func (export "listbox_get_item_text")
    (param $hwnd i32) (param $idx i32) (param $dest_guest i32) (param $max i32) (result i32)
    (local $s i32) (local $sw i32) (local $count i32) (local $items_w i32)
    (local $p i32) (local $i i32) (local $slen i32) (local $dest_w i32)
    (local.set $s (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $s)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $s)))
    (local.set $count (i32.load offset=12 (local.get $sw)))
    (if (i32.or (i32.lt_s (local.get $idx) (i32.const 0))
                (i32.ge_s (local.get $idx) (local.get $count)))
      (then (return (i32.const 0))))
    (local.set $items_w (call $g2w (i32.load (local.get $sw))))
    (local.set $p (local.get $items_w))
    (local.set $i (i32.const 0))
    (block $found (loop $skip
      (br_if $found (i32.eq (local.get $i) (local.get $idx)))
      (local.set $p (i32.add (local.get $p)
                      (i32.add (call $strlen (local.get $p)) (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $skip)))
    (local.set $slen (call $strlen (local.get $p)))
    (if (i32.le_u (local.get $max) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $slen) (local.get $max))
      (then (local.set $slen (i32.sub (local.get $max) (i32.const 1)))))
    (local.set $dest_w (call $g2w (local.get $dest_guest)))
    (call $memcpy (local.get $dest_w) (local.get $p) (local.get $slen))
    (i32.store8 (i32.add (local.get $dest_w) (local.get $slen)) (i32.const 0))
    (local.get $slen))

  ;; StaticState text reader (StaticState layout matches ButtonState for the
  ;; first two fields: text_buf_ptr / text_len).
  (func (export "static_get_text")
    (param $hwnd i32) (param $dest_guest i32) (param $max i32) (result i32)
    (local $state i32) (local $sw i32) (local $len i32) (local $src i32)
    (local.set $state (call $wnd_get_state_ptr (local.get $hwnd)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $src (i32.load (local.get $sw)))
    (local.set $len (i32.load offset=4 (local.get $sw)))
    (if (i32.le_u (local.get $max) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $len) (local.get $max))
      (then (local.set $len (i32.sub (local.get $max) (i32.const 1)))))
    (if (local.get $src)
      (then (if (local.get $len)
              (then (call $memcpy (call $g2w (local.get $dest_guest))
                                  (call $g2w (local.get $src))
                                  (local.get $len))))))
    (i32.store8 (i32.add (call $g2w (local.get $dest_guest)) (local.get $len)) (i32.const 0))
    (local.get $len))

)
