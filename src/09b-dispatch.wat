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
    ;; Stack layout: [ESP] = saved_ret, [ESP+4] = saved_hwnd (pushed before WndProc args)
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
        (call $gs32 (global.get $esp) (i32.add (global.get $image_base) (i32.const 0x100)))
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
        (local.set $arg4 (i32.const 0))  ;; reuse as wndproc temp
        ;; If EndDialog was called, destroy dialog and return result
        (if (global.get $dlg_ended)
          (then
            ;; Destroy WAT-managed child controls (sends WM_DESTROY to each)
            ;; but not the dialog itself — its x86 dlg_proc would interpret
            ;; WM_DESTROY as app shutdown and call PostQuitMessage.
            (call $wnd_destroy_children (global.get $dlg_hwnd))
            (call $wnd_table_remove (global.get $dlg_hwnd))
            (call $host_destroy_window (global.get $dlg_hwnd))
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
            ;; Dispatch by hwnd wndproc — WAT-native controls handle directly
            (local.set $arg4 (call $wnd_table_get (local.get $arg0)))
            (if (i32.ge_u (local.get $arg4) (i32.const 0xFFFF0000))
              (then
                (drop (call $wat_wndproc_dispatch
                  (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
                ;; Re-enter dialog loop
                (global.set $eip (global.get $dlg_loop_thunk))
                (global.set $steps (i32.const 0))
                (return)))
            ;; x86 wndproc or dialog proc — call via guest stack
            (if (i32.eqz (local.get $arg4))
              (then (local.set $arg4 (global.get $dlg_proc))))
            (global.set $esp (i32.sub (global.get $esp) (i32.const 20)))
            (call $gs32 (global.get $esp) (global.get $dlg_loop_thunk))
            (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $arg0))
            (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (local.get $arg1))
            (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $arg2))
            (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $arg3))
            (global.set $eip (local.get $arg4))
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
            (if (local.get $arg0)
              (then
                ;; Host specified a target hwnd — dispatch by its wndproc
                (local.set $arg4 (call $wnd_table_get (local.get $arg0)))
                (if (i32.ge_u (local.get $arg4) (i32.const 0xFFFF0000))
                  (then
                    (drop (call $wat_wndproc_dispatch
                      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
                    (global.set $eip (global.get $dlg_loop_thunk))
                    (global.set $steps (i32.const 0))
                    (return)))
                (if (i32.eqz (local.get $arg4))
                  (then (local.set $arg4 (global.get $dlg_proc)))))
              (else
                ;; No target hwnd — dispatch to the modal dialog proc
                (local.set $arg0 (global.get $dlg_hwnd))
                (local.set $arg4 (global.get $dlg_proc))))
            (global.set $esp (i32.sub (global.get $esp) (i32.const 20)))
            (call $gs32 (global.get $esp) (global.get $dlg_loop_thunk))
            (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (local.get $arg0))
            (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (local.get $arg1))
            (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $arg2))
            (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (local.get $arg3))
            (global.set $eip (local.get $arg4))
            (global.set $steps (i32.const 0))
            (return)))
        ;; No input — yield to host and come back
        (global.set $yield_flag (i32.const 1))
        (global.set $eip (global.get $dlg_loop_thunk))
        (global.set $steps (i32.const 0))
        (return)))

    ;; Modal common-dialog pump (marker 0xCACA0006)
    ;; Set by $modal_begin. Each interpreter pass through this thunk:
    ;;   - if $modal_dlg_hwnd != 0 (dialog still open): set yield_flag and
    ;;     return — JS regains control, processes input via DOM events
    ;;     which feed renderer.handleMouseDown → send_message into the
    ;;     dialog's WAT children. The dialog's wndproc clears
    ;;     $modal_dlg_hwnd on OK/Cancel via $modal_done_*.
    ;;   - else (dialog destroyed): restore the saved EIP/ESP/EAX from
    ;;     before the API call, advance ESP past the original args, and
    ;;     return. EIP is now back in guest code, the API call has
    ;;     "returned" with the chosen result.
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0006))
      (then
        (if (global.get $modal_dlg_hwnd)
          (then
            (global.set $yield_flag (i32.const 1))
            (return)))
        ;; Modal complete — splice the API call back together.
        (global.set $eax (global.get $modal_result))
        (global.set $eip (global.get $modal_ret_addr))
        (global.set $esp (i32.add (global.get $modal_saved_esp) (global.get $modal_esp_adjust)))
        (global.set $yield_reason (i32.const 0))
        (return)))

    ;; _initterm continuation — init function returned, call next entry
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0003))
      (then
        (local.set $arg0 (i32.const 0))
        ;; Find next non-NULL entry
        (block $done (loop $scan
          (br_if $done (i32.ge_u (global.get $initterm_ptr) (global.get $initterm_end)))
          (local.set $arg0 (call $gl32 (global.get $initterm_ptr)))
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

    ;; Unresolved ordinal import from a system DLL (marker "ORD\0")
    ;; — $api_id holds the actual ordinal. Format "KERNEL32.#NNNNN" into
    ;; the scratch buffer at 0x2DA and crash with that name so the user
    ;; sees exactly which ordinal needs implementing.
    (if (i32.eq (local.get $name_rva) (i32.const 0x4F524400))
      (then
        ;; Write 5 decimal digits of $api_id into buffer at WASM 0x2DA..0x2DE
        (local.set $arg0 (local.get $api_id))
        (i32.store8 (i32.const 0x2DE) (i32.add (i32.const 0x30) (i32.rem_u (local.get $arg0) (i32.const 10))))
        (local.set $arg0 (i32.div_u (local.get $arg0) (i32.const 10)))
        (i32.store8 (i32.const 0x2DD) (i32.add (i32.const 0x30) (i32.rem_u (local.get $arg0) (i32.const 10))))
        (local.set $arg0 (i32.div_u (local.get $arg0) (i32.const 10)))
        (i32.store8 (i32.const 0x2DC) (i32.add (i32.const 0x30) (i32.rem_u (local.get $arg0) (i32.const 10))))
        (local.set $arg0 (i32.div_u (local.get $arg0) (i32.const 10)))
        (i32.store8 (i32.const 0x2DB) (i32.add (i32.const 0x30) (i32.rem_u (local.get $arg0) (i32.const 10))))
        (local.set $arg0 (i32.div_u (local.get $arg0) (i32.const 10)))
        (i32.store8 (i32.const 0x2DA) (i32.add (i32.const 0x30) (i32.rem_u (local.get $arg0) (i32.const 10))))
        ;; Log as a synthetic API name so --verbose/--trace-api pick it up
        (call $host_log (i32.const 0x2D0) (i32.const 15))
        (call $crash_unimplemented (i32.const 0x2D0))
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
