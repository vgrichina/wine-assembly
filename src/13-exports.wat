  ;; ============================================================
  ;; MAIN RUN LOOP
  ;; ============================================================
  (func $run (export "run") (param $max_blocks i32)
    (local $thread i32) (local $blocks i32)
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
      ;; Watchpoint: break when watched dword changes
      (if (global.get $watch_addr)
        (then
          (if (i32.ne (call $gl32 (global.get $watch_addr)) (global.get $watch_val))
            (then
              (global.set $watch_val (call $gl32 (global.get $watch_addr)))
              (br $halt)))))
      ;; Yield flag — host needs control (e.g. after WM_TIMER delivery)
      (if (global.get $yield_flag)
        (then
          (global.set $yield_flag (i32.const 0))
          (br $halt)))
      ;; EIP breakpoint
      (if (i32.eq (global.get $eip) (global.get $bp_addr))
        (then (br $halt)))
      ;; If EIP landed in thunk zone (e.g. ret-to-thunk for sync message continuation),
      ;; dispatch the thunk directly instead of trying to decode it as x86
      (if (i32.and (i32.ge_u (global.get $eip) (global.get $thunk_guest_base))
                   (i32.lt_u (global.get $eip) (global.get $thunk_guest_end)))
        (then
          (call $win32_dispatch (i32.div_u
            (i32.sub (global.get $eip) (global.get $thunk_guest_base)) (i32.const 8)))
          (br $main)))
      ;; DEBUG: count entries into the wall-error call site (was diagnosing FUCOMPP bug)
      (if (i32.eq (global.get $eip) (i32.const 0x01009604))
        (then
          (call $host_log_i32 (i32.const 0xDEC0DE19))
          (call $host_log_i32 (global.get $eax))
          (call $host_log_i32 (call $gl32 (i32.add (global.get $edi) (i32.const 8))))))
      (global.set $dbg_prev_eip (global.get $eip))
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

  ;; Thread init — called by host after creating worker instance
  (func (export "init_thread") (param $tid i32)
      (param $img_base i32) (param $code_s i32) (param $code_e i32)
      (param $thunk_gs i32) (param $thunk_ge i32) (param $num_th i32)
    (global.set $THREAD_BASE (i32.add (i32.const 0x01D52000)
      (i32.mul (local.get $tid) (i32.const 0x80000))))
    (global.set $CACHE_INDEX (i32.add (i32.const 0x02252000)
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
  (func (export "clear_yield") (global.set $yield_reason (i32.const 0)))
  (func (export "get_com_dll_name") (result i32) (global.get $com_dll_name))

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
  (func (export "set_watchpoint") (param $addr i32)
    (global.set $watch_addr (local.get $addr))
    (if (local.get $addr)
      (then (global.set $watch_val (call $gl32 (local.get $addr))))
      (else (global.set $watch_val (i32.const 0)))))
  (func (export "get_watch_val") (result i32) (global.get $watch_val))
  (func (export "get_watch_addr") (result i32) (global.get $watch_addr))

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

  ;; Write guest memory (guest addr)
  (func (export "guest_write32") (param $ga i32) (param $val i32)
    (call $gs32 (local.get $ga) (local.get $val)))
  (func (export "guest_read32") (param $ga i32) (result i32)
    (call $gl32 (local.get $ga)))

  ;; Allocate guest heap memory (returns guest address)
  (func (export "guest_alloc") (param $size i32) (result i32)
    (call $heap_alloc (local.get $size)))

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

  ;; Geometry getters: each returns x|y<<16 or w|h<<16 (i16 each).
  (func (export "ctrl_get_xy") (param $hwnd i32) (result i32)
    (call $ctrl_get_xy_packed (local.get $hwnd)))
  (func (export "ctrl_get_wh") (param $hwnd i32) (result i32)
    (call $ctrl_get_wh_packed (local.get $hwnd)))

  ;; Control class (1=Button, 2=Edit, 3=Static; 0 if not a control).
  (func (export "ctrl_get_class") (param $hwnd i32) (result i32)
    (call $ctrl_table_get_class (local.get $hwnd)))

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
