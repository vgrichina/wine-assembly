  ;; ============================================================
  ;; Win16 dialogs
  ;; ============================================================
  ;;
  ;; Two things stand between a 16-bit DialogBox and the dialog machinery the
  ;; 32-bit side already has, and this file is those two things.
  ;;
  ;; The first is the template. A 16-bit RT_DIALOG is not a narrowed 32-bit one,
  ;; it is a different structure: the item count is a byte, the strings are
  ;; ANSI, there is no extended style anywhere, nothing is aligned, and a
  ;; predefined control class is a single byte with no terminator rather than
  ;; 0xFFFF followed by a word. Rather than teach $dlg_load a second grammar,
  ;; $win16_dlg_to32 rewrites the template into the 32-bit form and hands that
  ;; over through $dlg_indirect_template_ptr — so every control, every style bit
  ;; and every dialog-unit conversion stays in one place.
  ;;
  ;; The second is the modal loop. DialogBoxParamA runs one by pointing EIP at
  ;; the guest procedure with a 32-bit frame beneath it and parking the return
  ;; on the CACA0004 thunk, which is the one shape a 16-bit task cannot survive
  ;; (see $win16_call32_begin). So DialogBox parks on a thunk-segment slot of
  ;; its own instead, and $win16_dlg_pump does the same work in Pascal: each
  ;; pass either hands one message to the dialog procedure and comes back when
  ;; it returns, or finds nothing to do and yields to the host.

  ;; ---- Rewriting the template ----
  ;;
  ;; A cursor over the destination, so the emitters below read as a sequence of
  ;; fields rather than as arithmetic.
  (global $win16_dlg_w (mut i32) (i32.const 0))

  (func $win16_dlg_emit16 (param $v i32)
    (call $gs16 (global.get $win16_dlg_w) (local.get $v))
    (global.set $win16_dlg_w (i32.add (global.get $win16_dlg_w) (i32.const 2))))

  (func $win16_dlg_emit32 (param $v i32)
    (call $gs32 (global.get $win16_dlg_w) (local.get $v))
    (global.set $win16_dlg_w (i32.add (global.get $win16_dlg_w) (i32.const 4))))

  ;; Widen a NUL-terminated ANSI string at `src` (a linear address in the staged
  ;; image) into a UTF-16 one, terminator included, and answer where the source
  ;; ended.
  (func $win16_dlg_emit_sz (param $src i32) (result i32)
    (local $c i32)
    (block $done (loop $copy
      (local.set $c (i32.load8_u (local.get $src)))
      (call $win16_dlg_emit16 (local.get $c))
      (local.set $src (i32.add (local.get $src) (i32.const 1)))
      (br_if $done (i32.eqz (local.get $c)))
      (br $copy)))
    (local.get $src))

  ;; The header's menu and class fields, and an item's text: absent (a lone
  ;; zero), an ordinal (0xFF then a word), or a string.
  (func $win16_dlg_emit_ord_or_sz (param $src i32) (result i32)
    (if (i32.eq (i32.load8_u (local.get $src)) (i32.const 0xFF))
      (then
        (call $win16_dlg_emit16 (i32.const 0xFFFF))
        (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 1))))
        (return (i32.add (local.get $src) (i32.const 3)))))
    (call $win16_dlg_emit_sz (local.get $src)))

  ;; $win16_dlg_to32(src) -> guest pointer to a 32-bit DLGTEMPLATE, or 0.
  ;;
  ;; `src` is a linear address of the 16-bit template. The rewritten one is four
  ;; times the source at the very worst — every byte of ANSI becomes a word of
  ;; UTF-16, and each item grows by its extended style and its alignment — so
  ;; the destination is sized from the resource length with room to spare.
  (func $win16_dlg_to32 (param $src i32) (param $src_len i32) (result i32)
    (local $dst i32) (local $style i32) (local $count i32) (local $i i32)
    (local $ctrl_style i32) (local $class i32)
    (local.set $dst (call $heap_alloc
      (i32.add (i32.mul (local.get $src_len) (i32.const 6)) (i32.const 256))))
    (if (i32.eqz (local.get $dst)) (then (return (i32.const 0))))
    (global.set $win16_dlg_w (local.get $dst))

    (local.set $style (i32.load (local.get $src)))
    (local.set $count (i32.load8_u (i32.add (local.get $src) (i32.const 4))))
    (call $win16_dlg_emit32 (local.get $style))
    (call $win16_dlg_emit32 (i32.const 0))                        ;; no exStyle in Win16
    (call $win16_dlg_emit16 (local.get $count))
    (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 5))))   ;; x
    (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 7))))   ;; y
    (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 9))))   ;; cx
    (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 11))))  ;; cy
    (local.set $src (i32.add (local.get $src) (i32.const 13)))
    (local.set $src (call $win16_dlg_emit_ord_or_sz (local.get $src)))   ;; menu
    (local.set $src (call $win16_dlg_emit_ord_or_sz (local.get $src)))   ;; class
    (local.set $src (call $win16_dlg_emit_sz (local.get $src)))          ;; caption
    ;; DS_SETFONT: point size then typeface. $dlg_load reads both back.
    (if (i32.and (local.get $style) (i32.const 0x40))
      (then
        (call $win16_dlg_emit16 (i32.load16_u (local.get $src)))
        (local.set $src (i32.add (local.get $src) (i32.const 2)))
        (local.set $src (call $win16_dlg_emit_sz (local.get $src)))))

    (local.set $i (i32.const 0))
    (block $done (loop $items
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      ;; Every 32-bit DLGITEMTEMPLATE starts on a DWORD boundary. Nothing in the
      ;; 16-bit one does.
      (block $aligned (loop $pad
        (br_if $aligned (i32.eqz (i32.and (global.get $win16_dlg_w) (i32.const 3))))
        (call $gs8 (global.get $win16_dlg_w) (i32.const 0))
        (global.set $win16_dlg_w (i32.add (global.get $win16_dlg_w) (i32.const 1)))
        (br $pad)))
      ;; x, y, cx, cy, id come before the style in a 16-bit item and after it in
      ;; a 32-bit one, so the style is read ahead rather than copied in place.
      (local.set $ctrl_style (i32.load (i32.add (local.get $src) (i32.const 10))))
      (call $win16_dlg_emit32 (local.get $ctrl_style))
      (call $win16_dlg_emit32 (i32.const 0))                      ;; exStyle
      (call $win16_dlg_emit16 (i32.load16_u (local.get $src)))                          ;; x
      (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 2))))   ;; y
      (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 4))))   ;; cx
      (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 6))))   ;; cy
      (call $win16_dlg_emit16 (i32.load16_u (i32.add (local.get $src) (i32.const 8))))   ;; id
      (local.set $src (i32.add (local.get $src) (i32.const 14)))
      ;; The class. One byte in the 0x80..0x85 range names a predefined class and
      ;; carries no terminator — the 32-bit spelling of the same thing is 0xFFFF
      ;; followed by that byte as a word.
      (local.set $class (i32.load8_u (local.get $src)))
      (if (i32.ge_u (local.get $class) (i32.const 0x80))
        (then
          (call $win16_dlg_emit16 (i32.const 0xFFFF))
          (call $win16_dlg_emit16 (local.get $class))
          (local.set $src (i32.add (local.get $src) (i32.const 1))))
        (else
          (local.set $src (call $win16_dlg_emit_sz (local.get $src)))))
      (local.set $src (call $win16_dlg_emit_ord_or_sz (local.get $src)))  ;; text
      ;; Creation data: one byte of count in Win16, a word in Win32. Neither
      ;; world's $dlg_load reads the bytes themselves, but both must skip them.
      (call $win16_dlg_emit16 (i32.const 0))
      (local.set $src (i32.add (i32.add (local.get $src) (i32.const 1))
                               (i32.load8_u (local.get $src))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $items)))
    (local.get $dst))

  ;; ---- DialogBox ----
  ;;
  ;; The state the pump needs sits on the task's stack under the parked EIP, so
  ;; that a dialog put up from inside another dialog's procedure keeps its own:
  ;;   [sp+0] dialog hwnd, 16-bit    [sp+2] return offset    [sp+4] return sel
  ;; A 16-bit window procedure RETFs its own arguments off, so this record is
  ;; exactly what the stack holds again each time one returns here.
  (func $win16_dlg_run (param $template i32) (param $parent i32) (param $proc i32)
        (param $init_param i32) (param $ret i32)
    (local $hwnd i32) (local $i i32) (local $ctrl i32)
    (local.set $hwnd (global.get $next_hwnd))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (call $wnd_table_set (local.get $hwnd) (global.get $WNDPROC_DIALOG))
    (drop (call $dialog_proc_set (local.get $hwnd) (local.get $proc)))
    (global.set $dlg_indirect_template_ptr (local.get $template))
    (drop (call $dlg_load (local.get $hwnd) (i32.const 0)))
    (call $heap_free (local.get $template))
    (call $wnd_set_parent (local.get $hwnd) (i32.const 0))
    (call $wnd_set_owner (local.get $hwnd) (local.get $parent))
    (drop (call $wnd_set_style (local.get $hwnd)
      (i32.or (call $wnd_get_style (local.get $hwnd)) (i32.const 0x10000000))))
    (call $host_dialog_loaded (local.get $hwnd) (local.get $parent))
    (call $defwndproc_do_nccalcsize (local.get $hwnd))
    (call $dlg_fill_bkgnd (local.get $hwnd))
    ;; Chrome and background both owed, and owed *before* the window is shown:
    ;; the visible-region pass that ShowWindow runs defers a native child's
    ;; paint while an ancestor still owes an erase, which is the only thing
    ;; keeping the controls from being drawn and then wiped by it.
    (call $nc_flags_set (local.get $hwnd) (i32.const 3))
    ;; Every control wants its first WM_PAINT; the pump delivers them once the
    ;; dialog is up. Walk the child slots rather than assuming the hwnds are
    ;; contiguous — a combobox allocates auxiliary windows of its own.
    (local.set $i (i32.const 0))
    (block $done (loop $seed
      (local.set $i (call $wnd_next_child_slot (local.get $hwnd) (local.get $i)))
      (br_if $done (i32.eq (local.get $i) (i32.const -1)))
      (local.set $ctrl (call $wnd_slot_hwnd (local.get $i)))
      (if (i32.and (call $wnd_get_style (local.get $ctrl)) (i32.const 0x10000000))
        (then (call $paint_flag_set_inv (local.get $ctrl))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $seed)))
    (drop (call $host_show_window (local.get $hwnd) (i32.const 1)))
    (global.set $win16_dlg_ended (i32.const 0))
    (call $win16_push16 (i32.shr_u (local.get $ret) (i32.const 16)))
    (call $win16_push16 (local.get $ret))
    (call $win16_push16 (call $win16_h16 (local.get $hwnd)))
    ;; WM_INITDIALOG. wParam is the control that would take focus; a Win16
    ;; dialog procedure returning TRUE means "leave it where USER put it".
    (call $win16_enter_wndproc (local.get $proc) (call $win16_h16 (local.get $hwnd))
      (i32.const 0x0110) (i32.const 0) (local.get $init_param)
      (global.get $WIN16_THUNK_SEL) (global.get $WIN16_DLG_PUMP)))

  ;; USER.87 DialogBox(hInstance, lpTemplateName, hWndParent, lpDialogFunc) and
  ;; USER.239 DialogBoxParam, which is the same with a dwInitParam under it.
  (func $win16_DialogBox (param $with_param i32)
    (local $id i32) (local $parent i32) (local $proc i32) (local $init i32)
    (local $res i32) (local $template i32) (local $base i32)
    (local.set $base (select (i32.const 2) (i32.const 0) (local.get $with_param)))
    (local.set $init (select
      (i32.or (call $win16_arg16 (i32.const 0))
              (i32.shl (call $win16_arg16 (i32.const 1)) (i32.const 16)))
      (i32.const 0) (local.get $with_param)))
    (local.set $proc (i32.or (call $win16_arg16 (local.get $base))
      (i32.shl (call $win16_arg16 (i32.add (local.get $base) (i32.const 1)))
               (i32.const 16))))
    (local.set $parent (call $win16_h32
      (call $win16_arg16 (i32.add (local.get $base) (i32.const 2)))))
    ;; lpTemplateName is a far pointer, and MAKEINTRESOURCE puts the id in the
    ;; offset with a null selector. A template named by string is not something
    ;; these apps do, and guessing at one would be worse than saying so.
    (if (call $win16_arg16 (i32.add (local.get $base) (i32.const 4)))
      (then
        (call $host_log_i32 (i32.const 0xCA16D1A6))
        (unreachable)))
    (local.set $id (call $win16_arg16 (i32.add (local.get $base) (i32.const 3))))
    (local.set $res (call $win16_find_resource (i32.const 5) (local.get $id)))
    (if (i32.eqz (local.get $res))
      (then
        (global.set $eax (i32.const -1))
        (call $win16_api_return (select (i32.const 16) (i32.const 12)
          (local.get $with_param)))
        (return)))
    (local.set $template
      (call $win16_dlg_to32 (local.get $res) (global.get $win16_res_len)))
    (call $win16_dlg_run (local.get $template) (local.get $parent) (local.get $proc)
      (local.get $init)
      (call $win16_take_return (select (i32.const 16) (i32.const 12)
        (local.get $with_param)))))

  ;; USER.218 DialogBoxIndirect is deliberately not here. Its template arrives
  ;; as an HGLOBAL rather than a resource id, and the only importer of it —
  ;; Hearts — has never reached the call, so there is nothing to check a guess
  ;; about the handle's shape against. It keeps its fail-fast stub until
  ;; something runs into it and can say what it passed.

  ;; USER.88 EndDialog(hDlg, nResult). The dialog procedure calls it and then
  ;; returns; the pump acts on it at that return, which is where Windows ends
  ;; the loop too.
  (func $win16_EndDialog
    (global.set $win16_dlg_result (call $win16_arg16 (i32.const 0)))
    (global.set $win16_dlg_ended (i32.const 1))
    (global.set $eax (i32.const 1))
    (call $win16_api_return (i32.const 4)))

  ;; ---- The pump ----
  ;;
  ;; Hand one message to `proc` and come back here when it returns. The record
  ;; below SP is untouched: a window procedure RETFs its own arguments off.
  (func $win16_dlg_send (param $proc i32) (param $hwnd i32) (param $msg i32)
        (param $wparam i32) (param $lparam i32)
    (call $win16_enter_wndproc (local.get $proc) (call $win16_h16 (local.get $hwnd))
      (local.get $msg) (local.get $wparam) (local.get $lparam)
      (global.get $WIN16_THUNK_SEL) (global.get $WIN16_DLG_PUMP)))

  ;; Route one message the way DispatchMessage would: a control built by
  ;; $dlg_load has a WAT window procedure and is handled here and now, the
  ;; dialog itself belongs to the task's DLGPROC, and any other window keeps its
  ;; own — a modal loop pumps the whole queue, not just the dialog's share.
  ;; Returns 1 if guest code was entered — the caller must not touch EIP again.
  (func $win16_dlg_route (param $dlg i32) (param $proc i32) (param $hwnd i32)
        (param $msg i32) (param $wparam i32) (param $lparam i32) (result i32)
    (local $target i32)
    (if (i32.eq (local.get $hwnd) (local.get $dlg))
      (then
        ;; A DLGPROC is not a window procedure: USER's DefDlgProc is, and it
        ;; keeps the non-client messages to itself. Handing WM_NCPAINT to the
        ;; task would mean nobody drew the caption, since a DLGPROC answers
        ;; "not mine" by returning FALSE and there is no default behind it here.
        (if (i32.eq (local.get $msg) (i32.const 0x0085))
          (then (call $defwndproc_do_ncpaint (local.get $hwnd)) (return (i32.const 0))))
        (if (i32.eq (local.get $msg) (i32.const 0x0083))
          (then (call $defwndproc_do_nccalcsize (local.get $hwnd)) (return (i32.const 0))))
        (if (i32.eq (local.get $msg) (i32.const 0x0014))
          (then
            (drop (call $host_erase_background (local.get $hwnd) (i32.const 16)))
            ;; The background has just been laid down over every control that
            ;; had already drawn on it, so this is the moment USER re-exposes
            ;; them. Going through the visible-region pass rather than the
            ;; update-region queue matters: the queue drops a control whose
            ;; update rect it cannot work out, which is how the OK and Cancel
            ;; buttons came out blank while the eleven above them did not.
            (drop (call $paint_flush_visible_native_children (local.get $hwnd)))
            (return (i32.const 0))))
        ;; A DLGPROC that does not handle WM_PAINT answers FALSE, and DefDlgProc
        ;; then validates the window through BeginPaint/EndPaint. Nothing does
        ;; that for us, and a dialog left dirty blocks every native child under
        ;; it — which is exactly how the OK and Cancel buttons went missing.
        (if (i32.eq (local.get $msg) (i32.const 0x000F))
          (then
            (call $paint_flag_clear_hwnd (local.get $hwnd))
            (call $update_clear_hwnd (local.get $hwnd))))
        (call $win16_dlg_send (local.get $proc) (local.get $hwnd) (local.get $msg)
          (local.get $wparam) (local.get $lparam))
        (return (i32.const 1))))
    (local.set $target (call $wnd_table_get (local.get $hwnd)))
    ;; No window procedure, or one of ours: nothing for the task to run.
    (if (i32.eqz (i32.shr_u (local.get $target) (i32.const 16)))
      (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $target) (i32.const 0xFFFF0000))
      (then
        (drop (call $wat_wndproc_dispatch (local.get $hwnd) (local.get $msg)
          (local.get $wparam) (local.get $lparam)))
        (return (i32.const 0))))
    (call $win16_dlg_send (local.get $target) (local.get $hwnd) (local.get $msg)
      (local.get $wparam) (local.get $lparam))
    (i32.const 1))

  ;; One pass. The message comes from the same $handle_GetMessageA the task's
  ;; own loop is bridged to, so a modal dialog sees the delivery order USER
  ;; defines — pending creates, the post queue, non-client work, painting,
  ;; input, timers — rather than a second opinion about it maintained here.
  (func $win16_dlg_pump
    (local $dlg i32) (local $proc i32) (local $scratch i32) (local $packed i32)
    (local $hwnd i32) (local $msg i32)
    (local.set $dlg (call $win16_h32 (call $gl16 (global.get $esp))))
    (local.set $proc (call $dialog_proc_get (local.get $dlg)))

    ;; EndDialog, and the procedure that called it has returned.
    (if (global.get $win16_dlg_ended)
      (then
        (global.set $win16_dlg_ended (i32.const 0))
        (call $wnd_destroy_children (local.get $dlg))
        (call $wnd_table_remove (local.get $dlg))
        (call $host_destroy_window (local.get $dlg))
        (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
        (local.set $packed (i32.or (call $gl16 (global.get $esp))
          (i32.shl (call $gl16 (i32.add (global.get $esp) (i32.const 2)))
                   (i32.const 16))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (global.set $eax (i32.and (global.get $win16_dlg_result) (i32.const 0xFFFF)))
        (global.set $edx (i32.const 0))
        (global.set $yield_reason (i32.const 0))
        (call $win16_set_sreg (i32.const 1) (i32.shr_u (local.get $packed) (i32.const 16)))
        (global.set $eip (i32.add (global.get $seg_base_cs)
          (i32.and (local.get $packed) (i32.const 0xFFFF))))
        (global.set $steps (i32.const 0))
        (return)))

    (local.set $scratch (global.get $GUEST_STACK))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_GetMessageA (local.get $scratch) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    ;; A GetMessage with nothing to give blocks by yielding rather than
    ;; returning, which this loop cannot do: park and let the host have its turn.
    (if (call $win16_call32_waited)
      (then
        (call $win16_call32_end)
        (call $win16_dlg_park)
        (global.set $yield_flag (i32.const 1))
        (return)))
    (call $win16_call32_end)
    (local.set $hwnd (call $gl32 (local.get $scratch)))
    (local.set $msg  (call $gl32 (i32.add (local.get $scratch) (i32.const 4))))
    (if (i32.eqz (local.get $msg))
      (then
        (call $win16_dlg_park)
        (global.set $yield_flag (i32.const 1))
        (return)))
    (if (call $win16_dlg_route (local.get $dlg) (local.get $proc) (local.get $hwnd)
          (local.get $msg)
          (call $win16_msg_wparam16
            (local.get $msg) (call $gl32 (i32.add (local.get $scratch) (i32.const 8))))
          (call $gl32 (i32.add (local.get $scratch) (i32.const 12))))
      (then (return)))
    (call $win16_dlg_park))

  (func $win16_dlg_park
    (call $win16_set_sreg (i32.const 1) (global.get $WIN16_THUNK_SEL))
    (global.set $eip (i32.add (global.get $seg_base_cs) (global.get $WIN16_DLG_PUMP)))
    (global.set $yield_reason (i32.const 6))
    (global.set $steps (i32.const 0)))

  ;; ---- Reaching a control by id ----
  ;;
  ;; These are the 32-bit handlers with narrower arguments, so they go over the
  ;; bridge. Only the handles need translating; a control id is a word in both
  ;; worlds.

  ;; USER.91 GetDlgItem(hDlg, nIDDlgItem) -> HWND.
  (func $win16_GetDlgItem
    (local $dlg i32)
    (local.set $dlg (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_GetDlgItem (local.get $dlg) (call $win16_arg16 (i32.const 0))
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (call $win16_h16 (global.get $eax)))
    (call $win16_api_return (i32.const 4)))

  ;; USER.96 CheckRadioButton(hDlg, nIDFirst, nIDLast, nIDCheck).
  (func $win16_CheckRadioButton
    (local $dlg i32)
    (local.set $dlg (call $win16_h32 (call $win16_arg16 (i32.const 3))))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_CheckRadioButton (local.get $dlg)
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))
      (call $win16_arg16 (i32.const 0)) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 8)))

  ;; USER.97 CheckDlgButton(hDlg, nIDButton, uCheck).
  (func $win16_CheckDlgButton
    (local $dlg i32)
    (local.set $dlg (call $win16_h32 (call $win16_arg16 (i32.const 2))))
    (call $win16_call32_begin (i32.const 3))
    (call $handle_CheckDlgButton (local.get $dlg)
      (call $win16_arg16 (i32.const 1)) (call $win16_arg16 (i32.const 0))
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 6)))

  ;; USER.98 IsDlgButtonChecked(hDlg, nIDButton).
  (func $win16_IsDlgButtonChecked
    (local $dlg i32)
    (local.set $dlg (call $win16_h32 (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 2))
    (call $handle_IsDlgButtonChecked (local.get $dlg) (call $win16_arg16 (i32.const 0))
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 4)))

  ;; USER.93 GetDlgItemText(hDlg, nIDDlgItem, lpString, nMaxCount) -> length.
  (func $win16_GetDlgItemText
    (local $dlg i32) (local $buf i32)
    (local.set $dlg (call $win16_h32 (call $win16_arg16 (i32.const 4))))
    (local.set $buf (call $win16_far_to_guest
      (call $win16_arg16 (i32.const 2)) (call $win16_arg16 (i32.const 1))))
    (call $win16_call32_begin (i32.const 4))
    (call $handle_GetDlgItemTextA (local.get $dlg) (call $win16_arg16 (i32.const 3))
      (local.get $buf) (call $win16_arg16 (i32.const 0)) (i32.const 0) (i32.const 0))
    (call $win16_call32_end)
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 10)))

  ;; USER.101 SendDlgItemMessage(hDlg, nIDDlgItem, wMsg, wParam, lParam) -> LONG.
  ;; lParam is the only DWORD, so it is the two words nearest the top.
  (func $win16_SendDlgItemMessage
    (local $dlg i32)
    (local.set $dlg (call $win16_h32 (call $win16_arg16 (i32.const 5))))
    (call $win16_call32_begin (i32.const 5))
    (call $handle_SendDlgItemMessageA (local.get $dlg)
      (call $win16_arg16 (i32.const 4)) (call $win16_arg16 (i32.const 3))
      (call $win16_arg16 (i32.const 2))
      (i32.or (call $win16_arg16 (i32.const 0))
              (i32.shl (call $win16_arg16 (i32.const 1)) (i32.const 16)))
      (i32.const 0))
    (call $win16_call32_end)
    (global.set $edx (i32.shr_u (global.get $eax) (i32.const 16)))
    (global.set $eax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (call $win16_api_return (i32.const 12)))
