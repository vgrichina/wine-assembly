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
        ;; If WS_VISIBLE was set on main_hwnd's style, kick off the implicit-show
        ;; activation chain (matches real Win32 CreateWindowEx behavior). Leaves
        ;; saved_ret/saved_hwnd in place at [ESP]/[ESP+4]; the chain ends by
        ;; re-entering CACA0001 with this flag cleared, which then pops them.
        (if (global.get $createwnd_implicit_show)
          (then
            (global.set $createwnd_implicit_show (i32.const 0))
            (global.set $show_window_activated (i32.const 1))
            ;; Push WndProc args: hwnd, WM_ACTIVATEAPP(0x001C), TRUE, 0
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (i32.const 0))                ;; lParam
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (i32.const 1))                ;; wParam = TRUE
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (i32.const 0x001C))           ;; WM_ACTIVATEAPP
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (global.get $main_hwnd))      ;; hwnd
            ;; Push CACA0022 as WndProc return — chains to ACTIVATE→SETFOCUS→SIZE→0001.
            (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
            (call $gs32 (global.get $esp) (global.get $createwnd_activate_thunk))
            (global.set $eip (call $wnd_table_get (global.get $main_hwnd)))
            (if (i32.eqz (global.get $eip))
              (then (global.set $eip (global.get $wndproc_addr))))
            (global.set $steps (i32.const 0))
            (return)))
        ;; Pop saved_ret and saved_hwnd from stack (supports nested CreateWindowExA)
        (global.set $eip (call $gl32 (global.get $esp)))
        (global.set $eax (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))

    ;; ── First-ShowWindow synchronous activation chain (main window only) ──
    ;; Triggered by $handle_ShowWindow on the first non-hide call for main_hwnd.
    ;; Each thunk: wndproc returned → push next message → call wndproc again.
    ;; Stack invariant: saved_ret and saved_hwnd sit at bottom throughout.
    ;; Chain: ShowWindow → CACA0022 (WM_ACTIVATE) → CACA0023 (WM_SETFOCUS)
    ;;      → CACA0001 (done, pop saved_ret+hwnd)

    ;; CACA0022: WM_ACTIVATEAPP returned → send WM_ACTIVATE synchronously
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0022))
      (then
        ;; Push WndProc args: hwnd, WM_ACTIVATE(0x0006), WA_ACTIVE(1), hwnd
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $main_hwnd))        ;; lParam = hwnd
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 1))                  ;; wParam = WA_ACTIVE
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0x0006))             ;; WM_ACTIVATE
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $main_hwnd))        ;; hwnd
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_setfocus_thunk))
        (global.set $eip (call $wnd_table_get (global.get $main_hwnd)))
        (if (i32.eqz (global.get $eip))
          (then (global.set $eip (global.get $wndproc_addr))))
        (global.set $steps (i32.const 0))
        (return)))

    ;; CACA0023: WM_ACTIVATE returned → send WM_SETFOCUS synchronously
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0023))
      (then
        ;; Push WndProc args: hwnd, WM_SETFOCUS(0x0007), 0, 0
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0))                  ;; lParam = 0
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0))                  ;; wParam = hwndLoseFocus
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0x0007))             ;; WM_SETFOCUS
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $main_hwnd))        ;; hwnd
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_size_thunk))
        (global.set $eip (call $wnd_table_get (global.get $main_hwnd)))
        (if (i32.eqz (global.get $eip))
          (then (global.set $eip (global.get $wndproc_addr))))
        (global.set $msg_phase (i32.const 5))  ;; skip all activation phases
        ;; Phase 2: seed paint_pending so first WM_PAINT arrives once the
        ;; WM_SETFOCUS handler returns (replaces legacy msg_phase==6 block).
        (global.set $paint_pending (i32.const 1))
        (global.set $steps (i32.const 0))
        (return)))

    ;; CACA0024: WM_SETFOCUS returned → send WM_SIZE synchronously
    ;; Restores Win32 invariant: ShowWindow's SetWindowPos delivers WM_SIZE
    ;; before any message loop / PostMessage'd command runs.
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0024))
      (then
        ;; Push WndProc args: hwnd, WM_SIZE(0x0005), SIZE_RESTORED(0), lParam=pending_wm_size
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $pending_wm_size))  ;; lParam = cx|(cy<<16)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0))                  ;; wParam = SIZE_RESTORED
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0x0005))             ;; WM_SIZE
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $main_hwnd))        ;; hwnd
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_ret_thunk))
        ;; Consume pending_wm_size so GetMessageA drain path doesn't replay it.
        (global.set $pending_wm_size (i32.const 0))
        ;; Match what the GetMessageA-drain path does: set WM_NCCALCSIZE pending.
        (call $nc_flags_set (global.get $main_hwnd) (i32.const 4))
        (global.set $eip (call $wnd_table_get (global.get $main_hwnd)))
        (if (i32.eqz (global.get $eip))
          (then (global.set $eip (global.get $wndproc_addr))))
        (global.set $steps (i32.const 0))
        (return)))

    ;; CBT hook continuation — hook returned, now dispatch WM_CREATE
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0002))
      (then
        ;; Push saved_hwnd and saved_ret below WndProc args (for CACA0001 to pop)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_saved_hwnd))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_saved_ret))
        ;; Push WndProc args: hwnd, WM_CREATE, 0, &CREATESTRUCT
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.add (global.get $image_base) (i32.const 0x100)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const 0x0001))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $createwnd_saved_hwnd))
        ;; Push return thunk: WM_CREATE returns directly (CACA0001).
        ;; Activation chain runs later from first ShowWindow.
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
            ;; Use $dlg_pump_hwnd: $dlg_hwnd may have been clobbered by a
            ;; nested modeless CreateDialogParamA inside the modal's dlgproc.
            (call $wnd_destroy_children (global.get $dlg_pump_hwnd))
            (call $wnd_table_remove (global.get $dlg_pump_hwnd))
            (call $host_destroy_window (global.get $dlg_pump_hwnd))
            (global.set $eax (global.get $dlg_result))
            (global.set $eip (global.get $dlg_ret_addr))
            (global.set $dlg_pump_hwnd (i32.const 0))
            (global.set $dlg_ended (i32.const 0))
            (global.set $quit_flag (i32.const 0))
            (return)))
        ;; Drain nc_flags so the dialog's chrome and client-area erase
        ;; actually fire. The main GetMessageA path walks these via
        ;; nc_flags_scan; the modal pump used to skip them entirely, so
        ;; modal dialogs stayed chrome-less with a transparent client.
        ;; We drive the default handlers directly (bypassing the DlgProc)
        ;; since DlgProcs conventionally return FALSE for NC/erase and
        ;; expect DefDlgProc → DefWindowProc to do the drawing.
        (if (global.get $nc_flags_count)
          (then
            ;; WM_NCPAINT (bit 0)
            (local.set $arg0 (call $nc_flags_scan (i32.const 1)))
            (if (local.get $arg0)
              (then
                (call $nc_flags_clear (local.get $arg0) (i32.const 1))
                (call $defwndproc_do_ncpaint (local.get $arg0))
                (global.set $eip (global.get $dlg_loop_thunk))
                (global.set $steps (i32.const 0))
                (return)))
            ;; WM_ERASEBKGND (bit 1) — default: COLOR_BTNFACE for dialogs
            (local.set $arg0 (call $nc_flags_scan (i32.const 2)))
            (if (local.get $arg0)
              (then
                (call $nc_flags_clear (local.get $arg0) (i32.const 2))
                (drop (call $host_erase_background (local.get $arg0) (i32.const 16)))
                (global.set $eip (global.get $dlg_loop_thunk))
                (global.set $steps (i32.const 0))
                (return)))))
        ;; Drain paint queue — deliver WM_PAINT to pending hwnds.
        ;; Without this, controls added by $dlg_load (and children of
        ;; nested CreateDialogParamA calls inside WM_INITDIALOG) never
        ;; render while the dialog is modal — the outer frame draws via
        ;; synchronous NC paint but the client area stays blank.
        (if (i32.gt_u (global.get $paint_queue_count) (i32.const 0))
          (then
            (local.set $arg0 (call $paint_queue_pop))  ;; hwnd
            (local.set $arg1 (i32.const 0x000F))       ;; WM_PAINT
            (local.set $arg2 (i32.const 0))            ;; wParam
            (local.set $arg3 (i32.const 0))            ;; lParam
            (local.set $arg4 (call $wnd_table_get (local.get $arg0)))
            (if (i32.ge_u (local.get $arg4) (i32.const 0xFFFF0000))
              (then
                (drop (call $wat_wndproc_dispatch
                  (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
                (global.set $eip (global.get $dlg_loop_thunk))
                (global.set $steps (i32.const 0))
                (return)))
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
        ;; Check post queue next
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
                ;; No target hwnd — dispatch to the modal dialog proc.
                ;; Use $dlg_pump_hwnd (set only by DialogBoxParamA) so nested
                ;; modeless CreateDialogParamA inside the modal's dlgproc
                ;; can't reroute input to the inner sub-dialog.
                (local.set $arg0 (global.get $dlg_pump_hwnd))
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

    ;; Synchronous SendMessage continuation — WndProc returned
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0005))
      (then
        (global.set $eip (i32.const 0))  ;; Stop nested run loop
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

    ;; DirectDrawEnumerateA callback returned — set EAX=DD_OK and return to caller
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0007))
      (then
        ;; Pop the saved original return address
        (global.set $eip (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (global.set $eax (i32.const 0))  ;; DD_OK
        (return)))

    ;; EnumDisplayModes continuation — callback returned, try next mode
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0008))
      (then
        (call $enum_modes_continue)
        (return)))

    ;; D3D EnumDevices continuation — callback returned, try next device
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA000B))
      (then
        (call $d3d_enum_devices_continue)
        (return)))

    ;; mm_timer callback returned — restore caller-saved regs + flags
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA000A))
      (then
        (call $restore_caller_regs)
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

    ;; Resolved-ordinal import: thunk+0 holds (0x80000000 | ordinal), not an
    ;; IMAGE_IMPORT_BY_NAME RVA. host_resolve_ordinal found a real api_id, so
    ;; we have a handler to run — just substitute a placeholder name for
    ;; logging (and for any handler that prints name_ptr).
    (if (i32.and (local.get $name_rva) (i32.const 0x80000000))
      (then
        (local.set $name_ptr (i32.const 0x2E0))
        (call $host_log (local.get $name_ptr) (i32.const 5))
        (call $host_log_i32 (i32.or (i32.const 0xC0DE0000) (local.get $api_id))))
      (else
        (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))
        (call $host_log (local.get $name_ptr) (call $strlen (local.get $name_ptr)))))

    ;; Load args from guest stack
    (local.set $arg0 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (local.set $arg1 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    (local.set $arg2 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))
    (local.set $arg3 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (local.set $arg4 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))

    ;; Delegate to generated br_table
    (call $dispatch_api_table (local.get $api_id) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))

    ;; Post-handler ESP hook for --esp-delta audit
    (call $host_log_api_exit)
  )
