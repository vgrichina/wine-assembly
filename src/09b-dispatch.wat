  ;; ============================================================
  ;; WIN32 API DISPATCH — hand-written thunk handlers + arg loading
  ;; Calls $dispatch_api_table for the generated br_table portion.
  ;; ============================================================
  (func $win32_dispatch (param $thunk_idx i32)
    (local $api_id i32) (local $name_rva i32) (local $name_ptr i32)
    (local $arg0 i32) (local $arg1 i32) (local $arg2 i32) (local $arg3 i32)
    (local $arg4 i32)

    ;; Read thunk data
    (local.set $name_rva (i32.load (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8)))))
    (local.set $api_id (i32.load (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8))) (i32.const 4))))

    ;; ── Continuation thunks (CACA markers) ──────────────────────

    ;; Catch-return thunk — SEH catch handler returned
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0000))
      (then (global.set $eip (global.get $eax)) (return)))

    ;; CreateWindowEx continuation — WndProc(WM_CREATE) returned
    ;; Stack: [ESP] = saved_ret, [ESP+4] = saved_hwnd (pushed before WndProc args)
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0001))
      (then
        ;; Pop saved_ret and saved_hwnd from stack (supports nested CreateWindowExA)
        (global.set $eip (call $gl32 (global.get $esp)))
        (global.set $eax (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; CBT hook continuation — hook returned, now dispatch WM_CREATE
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0002))
      (then
        ;; Push WndProc args: hwnd, WM_CREATE, 0, &CREATESTRUCT
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0x400100))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0x0001))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_saved_hwnd))
        ;; Push createwnd_ret_thunk as return address
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_ret_thunk))
        ;; Get WndProc from window table (may have been updated by CBT hook)
        (global.set $eip (call $wnd_table_get (global.get $createwnd_saved_hwnd)))
        (if (i32.eqz (global.get $eip))
          (then (global.set $eip (global.get $wndproc_addr))))
        (global.set $steps (i32.const 0))
        (return)))

    ;; DialogBoxParamA continuation — dialog proc returned, pump next message or finish
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0004))
      (then
        ;; If EndDialog was called, return result to original caller
        (if (global.get $dlg_ended)
          (then
            (global.set $eax (global.get $dlg_result))
            (global.set $eip (global.get $dlg_ret_addr))
            (global.set $dlg_ended (i32.const 0))
            (global.set $quit_flag (i32.const 0))
            (return)))
        ;; Check post queue first
        (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
          (then
            (local.set $arg0 (i32.load (i32.const 0x400)))        ;; hwnd
            (local.set $arg1 (i32.load (i32.const 0x404)))        ;; msg
            (local.set $arg2 (i32.load (i32.const 0x408)))        ;; wParam
            (local.set $arg3 (i32.load (i32.const 0x40c)))        ;; lParam
            ;; Shift queue
            (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
            (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
              (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
                (i32.mul (global.get $post_queue_count) (i32.const 16)))))
            ;; Dispatch to dialog proc
            (global.set $esp (i32.sub (global.get $esp) (i32.const 20)))
            (call $gs32 (global.get $esp) (global.get $dlg_loop_thunk))
            (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $arg0))
            (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (local.get $arg1))
            (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $arg2))
            (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $arg3))
            (global.set $eip (global.get $dlg_proc))
            (global.set $steps (i32.const 0))
            (return)))
        ;; Poll host for input
        (local.set $arg0 (call $host_check_input))
        (if (local.get $arg0)
          (then
            ;; Unpack: msg = low 16 bits, wParam = high 16 bits
            (local.set $arg1 (i32.and (local.get $arg0) (i32.const 0xFFFF)))      ;; msg
            (local.set $arg2 (i32.shr_u (local.get $arg0) (i32.const 16)))        ;; wParam
            (local.set $arg3 (call $host_check_input_lparam))                      ;; lParam
            (local.set $arg0 (call $host_check_input_hwnd))                        ;; hwnd
            (if (i32.eqz (local.get $arg0))
              (then (local.set $arg0 (global.get $dlg_hwnd))))
            ;; Dispatch to dialog proc
            (global.set $esp (i32.sub (global.get $esp) (i32.const 20)))
            (call $gs32 (global.get $esp) (global.get $dlg_loop_thunk))
            (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $arg0))
            (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (local.get $arg1))
            (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $arg2))
            (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $arg3))
            (global.set $eip (global.get $dlg_proc))
            (global.set $steps (i32.const 0))
            (return)))
        ;; No input — yield to host and come back
        (global.set $yield_flag (i32.const 1))
        (global.set $eip (global.get $dlg_loop_thunk))
        (global.set $steps (i32.const 0))
        (return)))

    ;; _initterm continuation — init function returned, call next entry
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0003))
      (then
        (local.set $arg0 (i32.const 0))
        ;; Find next non-NULL entry
        (block $done (loop $scan
          (br_if $done (i32.ge_u (global.get $initterm_ptr) (global.get $initterm_end)))
          (local.set $arg0 (call $gl32 (call $g2w (global.get $initterm_ptr))))
          (global.set $initterm_ptr (i32.add (global.get $initterm_ptr) (i32.const 4)))
          (if (local.get $arg0)
            (then
              (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
              (call $gs32 (global.get $esp) (global.get $initterm_thunk))
              (global.set $eip (local.get $arg0))
              (global.set $steps (i32.const 0))
              (return)))
          (br $scan)))
        ;; All done — return to original _initterm caller
        (global.set $eip (global.get $initterm_ret))
        (return)))

    ;; ── Normal API dispatch ─────────────────────────────────────

    (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))

    ;; Log API name for tracing
    (call $host_log (local.get $name_ptr) (call $strlen (local.get $name_ptr)))

    ;; Load args from guest stack
    (local.set $arg0 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (local.set $arg1 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    (local.set $arg2 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))
    (local.set $arg3 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (local.set $arg4 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))

    ;; Delegate to generated br_table
    (call $dispatch_api_table (local.get $api_id) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )
