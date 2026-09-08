  ;; ============================================================
  ;; NO `(module` OPENER HERE, AND NONE ANYWHERE IN src/.
  ;; Every src/*.wat fragment balances its own parentheses; the outer
  ;; (module ...) wrapper is supplied by the consumer:
  ;;   - lib/compile-wat.js treats bare top-level forms as module fields;
  ;;   - tools/concat-wat.js wraps build/combined.wat for standard-WAT tools.
  ;; tools/check-wat-fragments.js gates this — every fragment must net zero.
  ;; The authoritative source order is src/main.watx.
  ;; ============================================================
  ;; ============================================================
  ;; Wine-Assembly: Windows 98 PE interpreter in raw WAT
  ;; Forth-style threaded code x86 interpreter — full i486 ISA
  ;; ============================================================

  ;; ---- Host imports ----
  (import "host" "log" (func $host_log (param i32 i32)))
  (import "host" "log_i32" (func $host_log_i32 (param i32)))
  (import "host" "log_api_exit" (func $host_log_api_exit))
  (import "host" "log_block" (func $host_log_block (param i32 i32)))
  ;; log_block(eip, esp) — invoked at the top of each decoded block when
  ;; trace_esp_flag is non-zero and EIP is inside [trace_esp_lo, trace_esp_hi].
  ;; Host default is a no-op; test/run.js --trace-esp wires it up.
  (import "host" "log_eip" (func $host_log_eip (param i32)))
  ;; log_eip(eip) — invoked at block entry when trace_eip_flag is non-zero and
  ;; EIP is inside [trace_eip_lo, trace_eip_hi]. test/run.js --trace-eip-range wires it up.
  (import "host" "crash_unimplemented" (func $host_crash_unimplemented (param i32 i32 i32 i32)))
  (import "host" "unhandled_exception" (func $host_unhandled_exception (param i32 i32 i32 i32)))
  (import "host" "cxx_throw" (func $host_cxx_throw (param i32)))
  (import "host" "message_box" (func $host_message_box (param i32 i32 i32 i32) (result i32)))
  (import "host" "exit" (func $host_exit (param i32)))
  (import "host" "draw_rect" (func $host_draw_rect (param i32 i32 i32 i32 i32)))
  (import "host" "read_file" (func $host_read_file (param i32 i32 i32) (result i32)))
  (import "host" "shell_extract_icon_resource" (func $host_shell_extract_icon_resource
    (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "host" "get_ticks" (func $host_get_ticks (result i32)))
  ;; Wall clock, as against the guest clock above, which a harness may
  ;; synthesise — test/run.js derives get_ticks from the batch counter. Use
  ;; this only to bound a wait on something outside this instance.
  (import "host" "real_time_ms" (func $host_real_time_ms (result i32)))
  (import "host" "yield" (func $host_yield (param i32)))
  ;; One bounded inline turn for the worker threads, for the case where the
  ;; main instance cannot yield: inside a synchronous wndproc the interpreter
  ;; frame in $wnd_send_message is on the WASM stack and a yield abandons it.
  ;; Returns the number of thread slices actually run (0 = nobody to run, or
  ;; we are already inside a worker and must not re-enter one).
  (import "host" "cs_pump" (func $host_cs_pump (result i32)))
  (import "host" "resolve_ordinal" (func $host_resolve_ordinal (param i32 i32) (result i32)))
  ;; resolve_ordinal(dll_name_ptr, ordinal) → api_id (-1 if unknown)
  ;; GUI host imports — call into JS canvas renderer
  (import "host" "create_window" (func $host_create_window (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; create_window(hwnd, style, x, y, cx, cy, title_ptr, menu_id) → hwnd
  (import "host" "show_window" (func $host_show_window (param i32 i32) (result i32)))
  (import "host" "set_cursor" (func $host_set_cursor (param i32)))
  ;; set_cursor_image(hcur, width, height, hot_x, hot_y, bgra_wa) — present a
  ;; cursor the guest BUILT rather than loaded: CreateIconIndirect hands over
  ;; bitmaps, and WAT composites their AND/XOR planes into premultiplied BGRA
  ;; here. bgra_wa = 0 means "you already have the pixels for this handle",
  ;; so a game that re-selects one of its cursors every frame costs one call.
  (import "host" "set_cursor_image"
    (func $host_set_cursor_image (param i32 i32 i32 i32 i32 i32)))
  ;; show_window(hwnd, cmd) → packed client size (w | h<<16) after resize
  (import "host" "sys_command" (func $host_sys_command (param i32 i32)))
  ;; sys_command(hwnd, sc_code) — JS updates renderer geometry for
  ;; SC_MINIMIZE (0xF020), SC_MAXIMIZE (0xF030), SC_RESTORE (0xF120).
  (import "host" "dialog_loaded" (func $host_dialog_loaded (param i32 i32)))
  ;; dialog_loaded(dlg_hwnd, parent_hwnd) — called after $dlg_load has
  ;; parsed the RT_DIALOG template into WND_DLG_RECORDS + CONTROL_TABLE.
  ;; JS reads window+control state from WAT exports (dlg_*, ctrl_*) —
  ;; there is no JS-side template parser.
  (import "host" "set_window_text" (func $host_set_window_text (param i32 i32)))
  ;; set_window_text(hwnd, text_ptr)
  (import "host" "invalidate" (func $host_invalidate (param i32)))
  ;; invalidate(hwnd) — client-area damage: schedule a composite, nothing more.
  ;; The window's own non-client chrome is already dirtied by whoever changed it
  ;; ($nc_flags_set on create/show/move/text/menu), so an InvalidateRect on an
  ;; edit control must not drag a title bar + border redraw along with it.
  (import "host" "invalidate_frame" (func $host_invalidate_frame (param i32)))
  ;; invalidate_frame(hwnd) — the caller changed something the non-client area
  ;; draws (caption flash state, a frame becoming visible). Posts WM_NCPAINT.
  ;; Worker compositor publication brackets. They do not change USER/GDI
  ;; state; they only keep a BeginPaint/EndPaint transaction opaque across
  ;; browser Worker slice boundaries.
  (import "host" "paint_begin" (func $host_paint_begin (param i32)))
  (import "host" "paint_end" (func $host_paint_end (param i32)))
  (import "host" "move_window" (func $host_move_window (param i32 i32 i32 i32 i32 i32)))
  (import "host" "set_window_zorder" (func $host_set_window_zorder (param i32 i32)))
  (import "host" "sync_window_client" (func $host_sync_window_client (param i32 i32 i32 i32 i32)))
  ;; move_window(hwnd, x, y, w, h, flags)  flags: SWP_NOSIZE=1, SWP_NOMOVE=2
  (import "host" "get_window_rect" (func $host_get_window_rect (param i32 i32)))
  ;; get_window_rect(hwnd, wasmRectPtr) — writes left,top,right,bottom as i32s
  (import "host" "destroy_window" (func $host_destroy_window (param i32)))
  ;; destroy_window(hwnd) — remove from renderer's window table
  (import "host" "draw_text" (func $host_draw_text (param i32 i32 i32 i32 i32)))
  ;; draw_text(x, y, text_ptr, text_len, color)
  (import "host" "check_input" (func $host_check_input (result i32)))
  ;; check_input() → packed event (0 = none)
  (import "host" "check_input_lparam" (func $host_check_input_lparam (result i32)))
  ;; check_input_lparam() → lParam of last check_input event
  (import "host" "check_input_wparam" (func $host_check_input_wparam (result i32)))
  ;; check_input_wparam() → full wParam of last event (packed check_input keeps only 16 bits)
  (import "host" "check_input_hwnd" (func $host_check_input_hwnd (result i32)))
  ;; check_input_hwnd() → hwnd of last check_input event (0 = use main_hwnd)
  (import "host" "get_mouse_position" (func $host_get_mouse_position (result i32)))
  ;; get_mouse_position() → packed x | (y << 16), in renderer/source coords
  (import "host" "set_mouse_position" (func $host_set_mouse_position (param i32 i32)))
  ;; set_mouse_position(x, y) — update the renderer's virtual cursor
  (import "host" "get_mouse_buttons" (func $host_get_mouse_buttons (result i32)))
  ;; get_mouse_buttons() → MK_* style button bitmask (1=left, 2=right)
  (import "host" "set_window_class" (func $host_set_window_class (param i32 i32)))
  ;; set_window_class(hwnd, class_name_ptr)
  (import "host" "get_window_class" (func $host_get_window_class (param i32 i32 i32) (result i32)))
  ;; get_window_class(hwnd, buffer_wa, max_chars) → chars copied.
  (import "host" "set_parent" (func $host_set_parent (param i32 i32)))
  ;; set_parent(hwnd, newParentHwnd) — update renderer's parentHwnd (reparenting)
  (import "host" "set_menu" (func $host_set_menu (param i32 i32)))
  ;; set_menu(hwnd, menu_resource_id)
  (import "host" "menu_create" (func $host_menu_create (result i32)))
  (import "host" "menu_destroy" (func $host_menu_destroy (param i32) (result i32)))
  (import "host" "menu_append" (func $host_menu_append (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "menu_remove" (func $host_menu_remove (param i32 i32 i32 i32) (result i32)))
  ;; menu_append(hMenu, flags, idOrSubmenu, text_wa, isWide) -> bool
  (import "host" "shell_about" (func $host_shell_about (param i32 i32 i32) (result i32)))
  ;; shell_about(dlg_hwnd, owner_hwnd, szApp_ptr) → result
  ;; Bare logging hook only — the actual dialog is built entirely in WAT
  ;; by $handle_ShellAboutA → $create_about_dialog. JS just gets the call
  ;; for diagnostic [ShellAbout] log lines and never touches dialog state.
  (import "host" "register_dialog_frame"
    (func $host_register_dialog_frame (param i32 i32 i32 i32 i32 i32)))
  ;; ---- Open / Save common-dialog web hooks ----
  ;;
  ;; pick_file_upload(dlg_hwnd, dest_dir_wa) — browser only. Triggers a
  ;; native <input type="file"> picker. When the user selects a file, JS
  ;; reads it as bytes, writes it into the VFS at "<dest_dir>\<picked_name>",
  ;; then calls the upload_done(dlg_hwnd) export so WAT can refresh the
  ;; listbox + auto-select the new entry. In headless mode this is a no-op.
  (import "host" "pick_file_upload"
    (func $host_pick_file_upload (param i32 i32)))
  ;; file_download(path_wa) — browser only. Reads the VFS file at the given
  ;; path and triggers a Blob download via <a download>. In headless mode
  ;; this is a no-op.
  (import "host" "file_download"
    (func $host_file_download (param i32)))
  (import "host" "shell_execute" (func $host_shell_execute (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; notify_icon(action, hwnd, id, flags, callback_msg, hicon, tip_wa, tip_cap)
  ;; mirrors the Win98 notification-area repository in the browser shell.
  (import "host" "notify_icon"
    (func $host_notify_icon (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; exit_windows(mode) — the machine, not the process. The Shut Down Windows
  ;; dialog (09c3-controls.wat) and ExitWindowsEx both end here, with the
  ;; guest's own quit already decided; what the host does with the box is
  ;; its business. mode: 0 stand by, 1 shut down, 2 restart, 3 log off.
  ;; Returns 1 when the host took the request.
  (import "host" "exit_windows" (func $host_exit_windows (param i32) (result i32)))
  ;; has_dom() → 1 in browser, 0 in headless. Used by $create_open_dialog
  ;; to decide whether to render the Upload/Download buttons.
  (import "host" "has_dom"
    (func $host_has_dom (result i32)))
  ;; register_dialog_frame(dlg_hwnd, owner_hwnd, title_wa, w, h, kind)
  ;;   kind bit 0 = isAboutDialog (modal block flag)
  ;;   kind bit 1 = isFindDialog
  ;; Tells the JS renderer to add a windows[] entry for the dialog frame.
  ;; Geometry origin is offset from owner's (x,y) by +40,+40. The dialog
  ;; class style is hard-coded to 0x80C80000 (WS_CAPTION|WS_SYSMENU|WS_POPUP).
  ;; controls[] stays empty — children come from $ctrl_create_child and
  ;; are walked via the WAT child enumeration during paint and hit-test.
  (import "host" "richedit_stream" (func $host_richedit_stream (param i32 i32)))
  ;; richedit_stream(ctrl_hwnd, text_wasm_ptr) — set RichEdit control text
  (import "host" "send_ctrl_msg" (func $host_send_ctrl_msg (param i32 i32 i32 i32)))
  ;; send_ctrl_msg(ctrl_hwnd, msg, wParam, lParam) — forward control messages to renderer
  (import "host" "get_window_text" (func $host_get_window_text (param i32 i32 i32) (result i32)))
  ;; get_window_text(hwnd, bufWA, maxLen) → chars copied (top-level titles;
  ;; child control text goes through WM_GETTEXT directly).
  (import "host" "get_window_text_length" (func $host_get_window_text_length (param i32) (result i32)))
  ;; get_window_text_length(hwnd) → length in chars (no NUL).
  (import "host" "get_window_related" (func $host_get_window_related (param i32 i32) (result i32)))
  ;; get_window_related(hwnd, GW_*) → renderer-wide top-level relation.
  (import "host" "get_window_info" (func $host_get_window_info (param i32 i32) (result i32)))
  ;; get_window_info(hwnd, 0=style, 1=visible, 2=enabled, 3=pid, 4=exists) → renderer property.
  (import "host" "post_window_message" (func $host_post_window_message (param i32 i32 i32 i32) (result i32)))
  ;; post_window_message(...) → 1 when routed to another app instance.
  (import "host" "activate_window" (func $host_activate_window (param i32) (result i32)))
  (import "host" "foreground_window" (func $host_foreground_window (result i32)))
  ;; foreground_window() → renderer-wide foreground top-level HWND, or NULL.
  ;; arrange_windows(mode, flags, rectWA, count, hwndsWA):
  ;; mode 0=cascade, 1=tile, 2=arrange minimized icons.
  (import "host" "arrange_windows" (func $host_arrange_windows (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "get_screen_size" (func $host_get_screen_size (result i32)))
  ;; get_screen_size() → (width | (height << 16))
  (import "host" "set_wallpaper" (func $host_set_wallpaper (param i32 i32) (result i32)))
  ;; set_wallpaper(path_wa, tiled) → BOOL; loads a VFS BMP into the desktop layer.
  ;; Fixed-function frontends lower into a reusable WebGL/GLES-shaped backend.
  ;; opcode, stdcall stack WA, auxiliary target HWND -> integer/API result.
  (import "host" "gpu_gl_call"
    (func $host_gpu_gl_call (param i32 i32 i32) (result i32)))
  (import "host" "note_richedit_charformat_size" (func $host_note_richedit_charformat_size (param i32 i32 i32)))
  ;; note_richedit_charformat_size(yHeightTwips, selectionLo, selectionHi)
  ;; GDI host imports
  (func $host_gdi_create_pen (param i32 i32 i32) (result i32)
    (call $gdi_object_alloc (i32.const 1) (local.get 0) (local.get 1) (local.get 2)
      (i32.eq (local.get 0) (i32.const 5))))
  (func $host_gdi_create_solid_brush (param i32) (result i32)
    (call $gdi_object_alloc (i32.const 2) (i32.const 0) (i32.const 0)
      (local.get 0) (i32.const 0)))
  (func $host_gdi_create_compat_dc (param i32) (result i32) (call $gdi_dc_alloc))
  (func $host_gdi_create_compat_bitmap (param i32 i32 i32 i32) (result i32)
    (call $gdi_create_compat_bitmap_internal (local.get 1) (local.get 2) (local.get 3)))
  ;; gdi_create_compat_bitmap(hdc, width, height, backingWa) registers a DDB
  ;; whose private canonical pixels live at backingWa. The address is not
  ;; exposed through BITMAP.bmBits.
  (func $host_gdi_create_bitmap (param i32 i32 i32 i32) (result i32)
    (call $gdi_bitmap_create_bitmap (local.get 0) (local.get 1) (i32.const 1)
      (local.get 2) (local.get 3)))
  ;; gdi_create_bitmap(width, height, bitsPerPixel, lpBitsWasmAddr) → handle
  (func $host_gdi_create_dib_bitmap (param i32 i32 i32) (result i32)
    (call $gdi_bitmap_create_dibitmap (i32.const 0) (local.get 0) (local.get 1)
      (i32.ne (i32.and (local.get 2) (i32.const 4)) (i32.const 0)) (i32.const 0)))
  (func $host_gdi_get_object_bits (param i32) (result i32)
    (call $gdi_bitmap_public_bits (local.get 0)))
  ;; gdi_get_object_bits(hBitmap) → lpBits WASM address for DIB sections, or 0.
  (func $host_gdi_get_object_storage (param i32) (result i32)
    (call $gdi_bitmap_storage (local.get 0)))
  ;; gdi_get_object_storage(hBitmap) → private WAT backing address, or 0.
  (func $host_gdi_get_object_bpp (param i32) (result i32)
    (call $gdi_bitmap_bpp (local.get 0)))
  ;; gdi_get_object_bpp(hBitmap) → bitmap bits-per-pixel, or 0 if unknown.
  (func $host_gdi_select_object (param i32 i32) (result i32)
    (local $old i32)
    (local.set $old (call $gdi_dc_select_owned_object (local.get 0) (local.get 1)))
    (select (local.get $old) (i32.const 0) (i32.ne (local.get $old) (i32.const -1))))
  (func $host_gdi_delete_object (param i32) (result i32)
    (call $gdi_object_delete_full (local.get 0)))
  (func $host_gdi_delete_dc (param i32) (result i32)
    (call $gdi_dc_delete (local.get 0)))
  (func $host_gdi_rectangle (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_rectangle_desc (local.get $hdc) (local.get $desc)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
      (call $gdi_dc_get_rop2 (local.get $hdc))))
  ;; gdi_rectangle(hdc, left, top, right, bottom)
  (func $host_gdi_round_rect (param i32 i32 i32 i32 i32 i32 i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get 0) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_round_rect_desc (local.get 0) (local.get $desc)
      (local.get 1) (local.get 2) (local.get 3) (local.get 4) (local.get 5) (local.get 6)
      (call $gdi_dc_get_field (local.get 0) (i32.const 4) (i32.const 0x30017))
      (call $gdi_dc_get_field (local.get 0) (i32.const 8) (i32.const 0x30010))
      (call $gdi_dc_get_rop2 (local.get 0))))
  ;; gdi_round_rect(hdc, left, top, right, bottom, ellipseWidth, ellipseHeight)
  (func $host_gdi_fill_rect (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (param $brush i32) (result i32)
    (local $desc i32)
    (if (i32.eqz (local.get $brush))
      (then (local.set $brush
        (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010)))))
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_fill_rect_desc (local.get $hdc) (local.get $desc)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
      (local.get $brush)))
  (func $host_gdi_draw_edge (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (param $edge i32) (param $flags i32)
        (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_draw_edge_desc (local.get $hdc) (local.get $desc)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
      (local.get $edge) (local.get $flags) (i32.const 0)))
  ;; gdi_draw_focus_rect(hdc, left, top, right, bottom) — 1px dotted black rect.
  (func $host_gdi_draw_focus_rect (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_focus_rect_desc (local.get $hdc) (local.get $desc)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)))
  ;; gdi_gradient_fill_h(hdc, l, t, r, b, colorL, colorR) — horizontal linear gradient.
  ;; Win32 equivalent: GdiGradientFill(GRADIENT_FILL_RECT_H). Used by defwndproc_ncpaint.
  (func $host_gdi_gradient_fill_h
        (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32)
        (param $color_left i32) (param $color_right i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_gradient_fill_h_desc
      (local.get $hdc) (local.get $desc)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
      (local.get $color_left) (local.get $color_right)))
  ;; gdi_fill_rect(hdc, left, top, right, bottom, hbrush)
  (func $host_gdi_ellipse (param $hdc i32) (param $left i32) (param $top i32)
        (param $right i32) (param $bottom i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_ellipse_desc (local.get $hdc) (local.get $desc)
      (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
      (call $gdi_dc_get_rop2 (local.get $hdc))))
  ;; gdi_ellipse(hdc, left, top, right, bottom)
  (func $host_gdi_create_rect_rgn (param i32 i32 i32 i32) (result i32)
    (call $gdi_rgn_alloc_rect (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  ;; gdi_create_rect_rgn(l, t, r, b) -> hrgn
  (func $host_gdi_set_rect_rgn (param i32 i32 i32 i32 i32) (result i32)
    (call $gdi_rgn_set_rect
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
  ;; gdi_set_rect_rgn(hrgn, l, t, r, b) -> bool
  (import "host" "gdi_set_region_bands" (func $host_gdi_set_region_bands (param i32 i32 i32) (result i32)))
  ;; gdi_set_region_bands(hrgn, rects_wa, count) rebuilds derived Canvas data;
  ;; count=-1 discards that presentation cache.
  (func $host_gdi_combine_rgn (param i32 i32 i32 i32) (result i32)
    (call $gdi_rgn_combine (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  ;; gdi_combine_rgn(dst, src1, src2, mode) -> complexity
  (func $host_gdi_offset_rgn (param i32 i32 i32) (result i32)
    (call $gdi_rgn_offset (local.get 0) (local.get 1) (local.get 2)))
  ;; gdi_offset_rgn(hrgn, dx, dy) -> region complexity
  (func $host_gdi_fill_rgn (param i32 i32 i32) (result i32)
    (call $gdi_hdc_fill_rgn (local.get 0) (local.get 1) (local.get 2)))
  ;; gdi_fill_rgn(hdc, hrgn, hbrush) — hbrush=0 uses DC's current brush (for PaintRgn)
  (func $host_gdi_frame_rgn (param i32 i32 i32 i32 i32) (result i32)
    (call $gdi_hdc_frame_rgn
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
  ;; gdi_frame_rgn(hdc, hrgn, hbrush, width, height) -> bool
  (import "host" "gdi_set_window_rgn" (func $host_gdi_set_window_rgn (param i32 i32 i32) (result i32)))
  ;; gdi_set_window_rgn(hwnd, hrgn, redraw) -> bool
  (func $host_gdi_select_clip_rgn (param i32 i32) (result i32)
    (call $gdi_dc_clip_select (local.get 0) (local.get 1)))
  ;; gdi_select_clip_rgn(hdc, hrgn) -> complexity
  (func $host_gdi_ext_select_clip_rgn (param i32 i32 i32) (result i32)
    (call $gdi_dc_clip_ext_select (local.get 0) (local.get 1) (local.get 2)))
  ;; gdi_ext_select_clip_rgn(hdc, hrgn, fnMode) -> complexity
  (func $host_gdi_exclude_clip_rect (param i32 i32 i32 i32 i32) (result i32)
    (call $gdi_dc_clip_exclude_rect
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
  ;; gdi_exclude_clip_rect(hdc, l, t, r, b) -> complexity
  (func $host_gdi_intersect_clip_rect (param i32 i32 i32 i32 i32) (result i32)
    (call $gdi_dc_clip_intersect_rect
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
  ;; gdi_intersect_clip_rect(hdc, l, t, r, b) -> complexity
  (func $host_gdi_get_rgn_box (param i32 i32) (result i32)
    (call $gdi_rgn_get_box (local.get 0) (local.get 1)))
  ;; gdi_get_rgn_box(hrgn, lprect_wa) -> complexity
  (func $host_gdi_polygon (param $hdc i32) (param $points i32) (param $count i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (call $gdi_polygon_desc (local.get $hdc) (local.get $desc)
      (local.get $points) (local.get $count)
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017))
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010))
      (call $gdi_dc_get_rop2 (local.get $hdc))
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 76) (i32.const 1))))
  ;; gdi_polygon(hdc, pointsWaPtr, nCount)
  (func $host_gdi_poly_bezier (param i32 i32 i32 i32) (result i32)
    (call $gdi_poly_bezier (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  ;; gdi_poly_bezier(hdc, pointsWaPtr, nCount, fromCurrent)
  (func $host_gdi_polyline (param $hdc i32) (param $points i32) (param $count i32) (result i32)
    (call $gdi_polyline_try
      (local.get $hdc) (local.get $points) (local.get $count) (i32.const 0)))
  ;; gdi_polyline(hdc, pointsWaPtr, nCount) preserves the current position.
  (func $host_gdi_polyline_to (param $hdc i32) (param $points i32) (param $count i32) (result i32)
    (local $ok i32) (local $last i32)
    (local.set $ok (call $gdi_polyline_try
      (local.get $hdc) (local.get $points) (local.get $count) (i32.const 1)))
    (if (i32.and (local.get $ok) (i32.gt_u (local.get $count) (i32.const 0)))
      (then
        (local.set $last (i32.add (local.get $points)
          (i32.shl (i32.sub (local.get $count) (i32.const 1)) (i32.const 3))))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
          (i32.load (local.get $last)) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
          (i32.load offset=4 (local.get $last)) (i32.const 0)))))
    (local.get $ok))
  ;; gdi_polyline_to(hdc, pointsWaPtr, nCount)
  (func $host_gdi_move_to (param $hdc i32) (param $x i32) (param $y i32) (result i32)
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12) (local.get $x) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16) (local.get $y) (i32.const 0)))
    (i32.const 1))
  (func $host_gdi_line_to (param $hdc i32) (param $x i32) (param $y i32) (result i32)
    (local $from_x i32) (local $from_y i32) (local $ok i32)
    (local.set $from_x (call $gdi_dc_get_field (local.get $hdc) (i32.const 12) (i32.const 0)))
    (local.set $from_y (call $gdi_dc_get_field (local.get $hdc) (i32.const 16) (i32.const 0)))
    (global.set $gdi_line_style_phase (i32.const 0))
    (local.set $ok (call $gdi_line_try
      (local.get $hdc) (local.get $from_x) (local.get $from_y) (local.get $x) (local.get $y)))
    (if (local.get $ok)
      (then
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12) (local.get $x) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16) (local.get $y) (i32.const 0)))))
    (local.get $ok))
  ;; gdi_line_to(hdc, x, y)
  (func $host_gdi_get_line_descriptor (param $hdc i32) (param $desc i32) (result i32)
    (i32.and (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc))
      (call $gdi_line_descriptor_supported (local.get $desc))))
  ;; gdi_get_line_descriptor(hdc, desc_wa) -> 1 for a supported DIB/solid-pen target.
  (import "host" "gdi_surface_create" (func $host_gdi_surface_create
    (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  (import "host" "gdi_surface_upload" (func $host_gdi_surface_upload
    (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "gdi_surface_delete" (func $host_gdi_surface_delete (param i32) (result i32)))
  (import "host" "gdi_surface_attach" (func $host_gdi_surface_attach (param i32 i32) (result i32)))
  ;; The renderer owns global cross-process z-order. Screen-source reads ask
  ;; it to copy canonical surface bytes directly into this WAT screen bitmap;
  ;; no Canvas pixels are read back.
  (import "host" "gdi_screen_readback" (func $host_gdi_screen_readback
    (param i32 i32 i32 i32) (result i32)))
  (func $host_gdi_get_current_object (param $hdc i32) (param $type i32) (result i32)
    (if (i32.eq (local.get $type) (i32.const 1))
      (then (return (call $gdi_dc_get_field (local.get $hdc) (i32.const 4) (i32.const 0x30017)))))
    (if (i32.eq (local.get $type) (i32.const 2))
      (then (return (call $gdi_dc_get_field (local.get $hdc) (i32.const 8) (i32.const 0x30010)))))
    (if (i32.eq (local.get $type) (i32.const 5))
      (then (return (call $gdi_dc_selected_palette (local.get $hdc)))))
    (if (i32.eq (local.get $type) (i32.const 6))
      (then (return (call $gdi_dc_get_field (local.get $hdc) (i32.const 88) (i32.const 0x3001D)))))
    (if (i32.eq (local.get $type) (i32.const 7))
      (then (return (call $gdi_dc_get_field (local.get $hdc) (i32.const 84) (i32.const 0x30007)))))
    (i32.const 0))
  ;; gdi_get_current_object(hdc, objectType) → handle
  (func $host_gdi_arc (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_arc
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)
      (local.get 5) (local.get 6) (local.get 7) (local.get 8) (i32.const 0)))
  ;; gdi_arc(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd)
  (func $host_gdi_bitblt (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_hdc_bitblt
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)
      (local.get 5) (local.get 6) (local.get 7) (local.get 8)))
  ;; gdi_bitblt(dstDC, dx, dy, w, h, srcDC, sx, sy, rop)
  (func $host_gdi_transparent_blt (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_hdc_transparent_blt
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)
      (local.get 5) (local.get 6) (local.get 7) (local.get 8)))
  ;; gdi_transparent_blt(dstDC, dx, dy, w, h, srcDC, sx, sy, colorKey)
  (func $host_gdi_disabled_blt (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_hdc_disabled_blt
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)
      (local.get 5) (local.get 6) (local.get 7) (local.get 8)))
  ;; gdi_disabled_blt(dstDC, dx, dy, w, h, srcDC, sx, sy, colorKey)

  (func $host_gdi_stretch_blt (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_hdc_stretch_blt
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)
      (local.get 5) (local.get 6) (local.get 7) (local.get 8) (local.get 9)
      (local.get 10)))
  ;; gdi_stretch_blt(dstDC, dx, dy, dw, dh, srcDC, sx, sy, sw, sh, rop)
  (func $host_gdi_scroll_window (param i32 i32 i32 i32 i32) (result i32)
    (call $gdi_scroll_window
      (local.get 0) (local.get 1) (local.get 2)
      (if (result i32) (local.get 3) (then (call $g2w (local.get 3))) (else (i32.const 0)))
      (if (result i32) (local.get 4) (then (call $g2w (local.get 4))) (else (i32.const 0)))))
  ;; gdi_scroll_window(hwnd, dx, dy, prcScroll, prcClip)
  (import "host" "show_find_dialog" (func $host_show_find_dialog (param i32 i32 i32) (result i32)))
  ;; show_find_dialog(dlgHwnd, ownerHwnd, findreplace_guest_addr) → hwnd



  (func $host_gdi_get_clip_box (param i32) (result i32)
    (call $gdi_dc_target_size (local.get 0)))
  ;; gdi_get_clip_box(hdc) → packed w | (h << 16)
  (func $host_gdi_load_bitmap (param i32 i32) (result i32)
    (call $gdi_bitmap_load_resource (local.get 0) (local.get 1) (i32.const 0)))
  (func $host_gdi_get_object_w (param i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_object_record (local.get 0)))
    (if (result i32)
      (i32.and (i32.ne (local.get $record) (i32.const 0))
        (i32.eq (load.field.memarg GdiObject type (local.get $record)) (i32.const 3)))
      (then (load.field.memarg GdiBitmap width (local.get $record))) (else (i32.const 0))))
  (func $host_gdi_get_object_h (param i32) (result i32)
    (local $record i32)
    (local.set $record (call $gdi_object_record (local.get 0)))
    (if (result i32)
      (i32.and (i32.ne (local.get $record) (i32.const 0))
        (i32.eq (load.field.memarg GdiObject type (local.get $record)) (i32.const 3)))
      (then (load.field.memarg GdiBitmap height (local.get $record))) (else (i32.const 0))))
  (func $host_gdi_set_viewport_org (param i32 i32 i32) (result i32)
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 56) (local.get 1) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 60) (local.get 2) (i32.const 0)))
    (i32.const 1))
  (func $host_gdi_get_viewport_org_x (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 56) (i32.const 0)))
  (func $host_gdi_get_viewport_org_y (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 60) (i32.const 0)))
  (func $host_gdi_set_viewport_ext (param i32 i32 i32) (result i32)
    (if (i32.or (i32.eqz (local.get 1)) (i32.eqz (local.get 2)))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 64) (local.get 1) (i32.const 1)))
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 68) (local.get 2) (i32.const 1)))
    (i32.const 1))
  (func $host_gdi_get_viewport_ext_x (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 64) (i32.const 1)))
  (func $host_gdi_get_viewport_ext_y (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 68) (i32.const 1)))
  (func $host_gdi_set_window_org (param i32 i32 i32) (result i32)
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 40) (local.get 1) (i32.const 0)))
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 44) (local.get 2) (i32.const 0)))
    (i32.const 1))
  (func $host_gdi_get_window_org_x (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 40) (i32.const 0)))
  (func $host_gdi_get_window_org_y (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 44) (i32.const 0)))
  (func $host_gdi_set_window_ext (param i32 i32 i32) (result i32)
    (if (i32.or (i32.eqz (local.get 1)) (i32.eqz (local.get 2)))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 48) (local.get 1) (i32.const 1)))
    (drop (call $gdi_dc_set_field (local.get 0) (i32.const 52) (local.get 2) (i32.const 1)))
    (i32.const 1))
  (func $host_gdi_get_window_ext_x (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 48) (i32.const 1)))
  (func $host_gdi_get_window_ext_y (param i32) (result i32)
    (call $gdi_dc_get_field (local.get 0) (i32.const 52) (i32.const 1)))
  (func $host_gdi_set_pixel (param i32 i32 i32 i32) (result i32)
    (call $gdi_hdc_set_pixel (local.get 0) (local.get 1) (local.get 2) (local.get 3)))
  ;; gdi_set_pixel(hdc, x, y, color) → prev color
  (func $host_gdi_frame_rect (param i32 i32 i32 i32 i32 i32 i32) (result i32)
    (local $desc i32)
    (local.set $desc (global.get $GDI_LINE_DESC))
    (if (result i32) (call $gdi_surface_descriptor (local.get 0) (local.get $desc))
      (then (call $gdi_frame_rect_desc (local.get 0) (local.get $desc)
        (local.get 1) (local.get 2) (local.get 3) (local.get 4) (local.get 5)))
      (else (i32.const 0))))
  ;; gdi_frame_rect(hdc, left, top, right, bottom, hbrush, hwnd) → 1
  (func $host_gdi_get_pixel (param i32 i32 i32) (result i32)
    (call $gdi_hdc_get_pixel (local.get 0) (local.get 1) (local.get 2)))
  ;; gdi_get_pixel(hdc, x, y) → COLORREF
  (func $host_gdi_ext_flood_fill (param i32 i32 i32 i32 i32) (result i32)
    (call $gdi_hdc_ext_flood_fill
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)))
  ;; gdi_ext_flood_fill(hdc, x, y, color, fillType) → BOOL
  (func $host_gdi_get_di_bits (param i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_get_dibits
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (if (result i32) (local.get 4) (then (call $g2w (local.get 4))) (else (i32.const 0)))
      (local.get 5) (local.get 6)))
  ;; gdi_get_di_bits(hdc, hBitmap, startScan, numScans, bitsGA, bmiWA, colorUse) → numScans
  (func $host_gdi_set_dib_bits (param i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_set_dibits
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6)))
  ;; gdi_set_dib_bits(hdc, hBitmap, startScan, numScans, bitsWasmAddr, bmiWasmAddr, colorUse) → numScans
  (func $host_gdi_get_dib_color_table (param i32 i32 i32 i32) (result i32)
    (call $gdi_get_dib_color_table
      (local.get 0) (local.get 1) (local.get 2) (call $g2w (local.get 3))))
  ;; gdi_get_dib_color_table(hdc, startIdx, numEntries, colorsGA) → count
  (func $host_gdi_set_dib_to_device
        (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_set_dib_to_device
      (local.get 0) (local.get 1) (local.get 2) (local.get 3)
      (local.get 4) (local.get 5) (local.get 6) (local.get 7)
      (local.get 8) (local.get 9) (local.get 10) (local.get 11)))
  ;; gdi_set_dib_to_device(hdc, xDest, yDest, w, h, xSrc, ySrc, startScan, cLines, bitsWA, bmiWA, colorUse) → cLines
  (func $host_gdi_stretch_dib_bits (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
    (call $gdi_stretch_dibits
      (local.get 0) (local.get 1) (local.get 2) (local.get 3) (local.get 4)
      (local.get 5) (local.get 6) (local.get 7) (local.get 8)
      (local.get 9) (local.get 10) (local.get 11) (local.get 12)))
  ;; gdi_stretch_dib_bits(hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, bitsWA, bmiWA, usage, rop)

  ;; DirectX tracing hook — WAT calls this from Lock/Unlock/Blt/Flip/SetEntries/dx_present
  ;; JS formats and logs iff --trace-dx is set. kind: 1=Lock 2=Unlock 3=Blt 4=SetEntries 5=Present 6=Flip
  (import "host" "dx_trace" (func $host_dx_trace (param i32 i32 i32 i32 i32)))

  ;; DirectAnimation imports resolve an already-mounted/decode-marked image by
  ;; its UTF-16 VFS path, then copy the selected timeline frame into the
  ;; canonical DirectDraw DIB bound to DAView. The low/high time words are the
  ;; IEEE-754 double passed by the original Plus! 98 saver.
  (import "host" "da_image_resolve" (func $host_da_image_resolve (param i32) (result i32)))
  (import "host" "da_image_blit"
    (func $host_da_image_blit (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))

  ;; WAT-native control paint tracing hook — every WAT-owned control wndproc
  ;; paint, with the window-local rect it is about to draw into. GDI primitives
  ;; are rasterized inside WAT now, so --trace-gdi sees only surface binds and
  ;; can no longer answer "who drew these pixels". JS formats and logs iff
  ;; --trace-ctrl is set.
  (import "host" "ctrl_paint_trace"
    (func $host_ctrl_paint_trace (param i32 i32 i32 i32 i32 i32 i32)))

  ;; Every window-background erase, with the brush that will fill it and the
  ;; client rect it covers. A flat slab of colour where an application expects
  ;; its own art is almost always an erase: with GDI rasterized inside WAT the
  ;; fill leaves no host-side trace at all, and --trace-gdi cannot see it.
  ;; JS formats and logs iff --trace-erase is set.
  (import "host" "erase_trace"
    (func $host_erase_trace (param i32 i32 i32 i32)))

  ;; A guest address no mapping covers, with the EIP that reached for it.
  ;; Called only when --fault-null armed $fault_unmapped, so the normal miss
  ;; path is unchanged.
  (import "host" "unmapped_trace"
    (func $host_unmapped_trace (param i32 i32)))

  ;; Every standard scrollbar strip as it is painted: control-local rect,
  ;; orientation, and the page model it was handed. A strip that is flat grey
  ;; with no arrows is either a paint that never happened or one whose `long`
  ;; axis came out under 36px, and nothing else in a trace can tell those two
  ;; apart. Same --trace-ctrl gate as the paint lines above.
  (import "host" "ctrl_sb_trace"
    (func $host_ctrl_sb_trace (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)))

  ;; Registry host imports — backed by localStorage
  (import "host" "reg_open_key" (func $host_reg_open_key (param i32 i32 i32) (result i32)))
  ;; reg_open_key(hKey, subKeyWA, isWide) → hKey or 0
  (import "host" "reg_create_key" (func $host_reg_create_key (param i32 i32 i32 i32 i32) (result i32)))
  ;; reg_create_key(hKey, subKeyWA, phkResultGA, isWide, dispositionGA)
  ;; writes REG_CREATED_NEW_KEY(1) or REG_OPENED_EXISTING_KEY(2) when requested.
  (import "host" "reg_query_value" (func $host_reg_query_value (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; reg_query_value(hKey, nameWA, typeGA, dataGA, cbDataGA, isWide) → error code
  (import "host" "reg_set_value" (func $host_reg_set_value (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; reg_set_value(hKey, nameWA, type, dataGA, cbData, isWide) → error code
  (import "host" "reg_close_key" (func $host_reg_close_key (param i32) (result i32)))
  ;; reg_close_key(hKey) → 0
  (import "host" "reg_flush_key" (func $host_reg_flush_key (param i32) (result i32)))
  ;; reg_flush_key(hKey) → 0, or 6 (ERROR_INVALID_HANDLE) for an unknown handle
  (import "host" "reg_enum_key" (func $host_reg_enum_key (param i32 i32 i32 i32 i32) (result i32)))
  ;; reg_enum_key(hKey, dwIndex, lpNameGA, cchName, isWide) → error code
  ;; NOTE the address space: the name is written through the host's writeStr,
  ;; which translates guest→WASM itself, so this one takes a GUEST pointer while
  ;; reg_open_key/reg_create_key just above take WASM ones. Passing a WASM
  ;; address here writes the name somewhere else entirely and the call still
  ;; reports ERROR_SUCCESS with an empty buffer.
  (import "host" "reg_enum_value" (func $host_reg_enum_value (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; reg_enum_value(hKey, index, nameGA, nameLenGA, typeGA, dataGA, dataLenGA, isWide) → error code
  (import "host" "reg_query_info" (func $host_reg_query_info (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; reg_query_info(hKey, subCountGA, maxSubKeyGA, valueCountGA, maxValueNameGA, maxValueDataGA, isWide)
  (import "host" "reg_delete_key" (func $host_reg_delete_key (param i32 i32 i32) (result i32)))
  ;; reg_delete_key(hKey, subKeyWA, isWide) → error code (removes key + subkeys)
  (import "host" "reg_delete_value" (func $host_reg_delete_value (param i32 i32 i32) (result i32)))
  ;; reg_delete_value(hKey, valueNameWA, isWide) → error code

  ;; Audio host imports
  (import "host" "message_beep" (func $host_message_beep (param i32)))
  ;; message_beep(uType) — play system sound (0=default, 0x10=error, 0x30=warning, 0x40=info)
  (import "host" "play_sound" (func $host_play_sound (param i32 i32)))
  ;; play_sound(wasm_ptr, length) — play WAV data from WASM memory
  (import "host" "mci_open" (func $host_mci_open (param i32 i32 i32) (result i32)))
  ;; mci_open(device_type_or_wa, element_name_wa, flags) → opaque host device id
  (import "host" "mci_open_w" (func $host_mci_open_w (param i32 i32 i32) (result i32)))
  ;; mci_open_w(device_type_or_wa, element_name_wa, flags) → opaque host device id
  (import "host" "mci_command" (func $host_mci_command (param i32 i32 i32 i32) (result i32)))
  ;; mci_command(host_id, command, flags, params_wa) → MCIERR_*
  (import "host" "mci_string" (func $host_mci_string (param i32 i32 i32) (result i32)))
  ;; mci_string(cmd_wa, retbuf_wa, retlen) → MCIERR_*
  (import "host" "mci_get_device_id" (func $host_mci_get_device_id (param i32) (result i32)))
  ;; mci_get_device_id(name_wa) → host device id for an mciSendStringA alias, or 0
  (import "host" "midi_num_devs" (func $host_midi_num_devs (result i32)))
  ;; midi_num_devs() → number of MIDI output devices
  (import "host" "midi_out_open" (func $host_midi_out_open (param i32 i32 i32 i32) (result i32)))
  ;; midi_out_open(device_id, callback, callback_instance, flags) → opaque MIDI handle or 0
  (import "host" "midi_out_close" (func $host_midi_out_close (param i32) (result i32)))
  ;; midi_out_close(handle) → MMRESULT
  (import "host" "midi_out_short_msg" (func $host_midi_out_short_msg (param i32 i32) (result i32)))
  ;; midi_out_short_msg(handle, packed_msg) → MMRESULT
  (import "host" "midi_out_reset" (func $host_midi_out_reset (param i32) (result i32)))
  ;; midi_out_reset(handle) → MMRESULT
  (import "host" "midi_out_get_volume" (func $host_midi_out_get_volume (param i32 i32) (result i32)))
  ;; midi_out_get_volume(handle, out_volume_wa) → MMRESULT
  (import "host" "midi_out_set_volume" (func $host_midi_out_set_volume (param i32 i32) (result i32)))
  ;; midi_out_set_volume(handle, volume) → MMRESULT
  (import "host" "audio_mixer_get_volume" (func $host_audio_mixer_get_volume (param i32) (result i32)))
  (import "host" "audio_mixer_set_volume" (func $host_audio_mixer_set_volume (param i32 i32)))
  (import "host" "audio_mixer_get_mute" (func $host_audio_mixer_get_mute (param i32) (result i32)))
  (import "host" "audio_mixer_set_mute" (func $host_audio_mixer_set_mute (param i32 i32)))
  (import "host" "audio_mixer_get_peak" (func $host_audio_mixer_get_peak (param i32) (result i32)))
  ;; audio_mixer_* controls and meters the shared master(0), wave(1), and MIDI(2) buses.

  ;; INI file host imports — backed by localStorage
  (import "host" "ini_get_string" (func $host_ini_get_string (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; ini_get_string(appNameWA, keyNameWA, defaultWA, bufGA, bufSize, fileNameWA, isWide) → chars written
  (import "host" "ini_get_int" (func $host_ini_get_int (param i32 i32 i32 i32 i32) (result i32)))
  ;; ini_get_int(appNameWA, keyNameWA, nDefault, fileNameWA, isWide) → int value
  (import "host" "ini_write_string" (func $host_ini_write_string (param i32 i32 i32 i32 i32) (result i32)))
  ;; ini_write_string(appNameWA, keyNameWA, valueWA, fileNameWA, isWide) → BOOL

  (import "host" "get_window_client_size" (func $host_get_window_client_size (param i32) (result i32)))
  ;; get_window_client_size(hwnd) → (clientW | (clientH << 16))

  (import "host" "get_async_key_state" (func $host_get_async_key_state (param i32) (result i32)))
  (import "host" "get_key_down_state" (func $host_get_key_down_state (param i32) (result i32)))
  (import "host" "get_keyboard_state" (func $host_get_keyboard_state (param i32) (result i32)))
  (import "host" "set_key_down_state" (func $host_set_key_down_state (param i32) (param i32)))
  (import "host" "win16_stage_module" (func $host_win16_stage_module (param i32) (param i32) (result i32)))
  (import "host" "di_set_event_notification" (func $host_di_set_event_notification (param i32 i32) (result i32)))

  ;; Math host imports (for FPU transcendentals)
  (import "host" "math_sin" (func $host_math_sin (param f64) (result f64)))
  (import "host" "math_cos" (func $host_math_cos (param f64) (result f64)))
  (import "host" "math_tan" (func $host_math_tan (param f64) (result f64)))
  (import "host" "math_atan2" (func $host_math_atan2 (param f64 f64) (result f64)))
  (import "host" "math_log2" (func $host_math_log2 (param f64) (result f64)))
  (import "host" "math_pow" (func $host_math_pow (param f64 f64) (result f64)))
  (import "host" "math_pow2" (func $host_math_pow2 (param f64) (result f64)))

  ;; Filesystem host imports — backed by virtual FS
  (import "host" "fs_create_file" (func $host_fs_create_file (param i32 i32 i32 i32 i32) (result i32)))
  ;; fs_create_file(pathWA, access, creation, flagsAttrs, isWide) → handle
  (import "host" "fs_create_legacy_file" (func $host_fs_create_legacy_file (param i32 i32 i32 i32 i32) (result i32)))
  ;; fs_create_legacy_file(...) → 16-bit HFILE for _lopen/_lcreat
  (import "host" "fs_read_file" (func $host_fs_read_file (param i32 i32 i32 i32) (result i32)))
  ;; fs_read_file(handle, bufGA, nToRead, nReadGA) → BOOL
  (import "host" "fs_read_pending" (func $host_fs_read_pending (result i32)))
  ;; fs_read_pending() → 1 when the fs_read_file that just returned 0 is
  ;; waiting on bytes from a lazy (provider-backed) mount rather than failing.
  ;; ReadFile asks only on a zero return; every other i32 the read can return
  ;; is already spoken for as a BOOL at its other call sites.
  (import "host" "fs_write_file" (func $host_fs_write_file (param i32 i32 i32 i32) (result i32)))
  ;; fs_write_file(handle, bufGA, nToWrite, nWrittenGA) → BOOL
  (import "host" "fs_flush_file_buffers" (func $host_fs_flush_file_buffers (param i32) (result i32)))
  (import "host" "fs_close_handle" (func $host_fs_close_handle (param i32) (result i32)))
  (import "host" "fs_set_file_pointer" (func $host_fs_set_file_pointer (param i32 i32 i32) (result i32)))
  (import "host" "fs_set_end_of_file" (func $host_fs_set_end_of_file (param i32) (result i32)))
  (import "host" "fs_get_file_size" (func $host_fs_get_file_size (param i32) (result i32)))
  ;; fs_file_time(handle, set, creationWA, accessWA, writeWA) → Win32 error code
  (import "host" "fs_file_time" (func $host_fs_file_time (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "fs_get_file_attributes" (func $host_fs_get_file_attributes (param i32 i32) (result i32)))
  (import "host" "fs_set_file_attributes" (func $host_fs_set_file_attributes (param i32 i32 i32) (result i32)))
  (import "host" "fs_delete_file" (func $host_fs_delete_file (param i32 i32) (result i32)))
  (import "host" "fs_create_directory" (func $host_fs_create_directory (param i32 i32) (result i32)))
  (import "host" "fs_remove_directory" (func $host_fs_remove_directory (param i32 i32) (result i32)))
  (import "host" "fs_move_file" (func $host_fs_move_file (param i32 i32 i32) (result i32)))
  (import "host" "fs_copy_file" (func $host_fs_copy_file (param i32 i32 i32 i32) (result i32)))
  ;; fs_shell_file_operation(fromMultiSzWA, toMultiSzWA, op, flags) → shell result
  (import "host" "fs_shell_file_operation" (func $host_fs_shell_file_operation (param i32 i32 i32 i32) (result i32)))
  (import "host" "fs_find_first_file" (func $host_fs_find_first_file (param i32 i32 i32) (result i32)))
  (import "host" "fs_find_next_file" (func $host_fs_find_next_file (param i32 i32 i32) (result i32)))
  (import "host" "fs_find_close" (func $host_fs_find_close (param i32) (result i32)))
  (import "host" "fs_register_change_notification" (func $host_fs_register_change_notification (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "fs_next_change_notification" (func $host_fs_next_change_notification (param i32) (result i32)))
  (import "host" "fs_close_change_notification" (func $host_fs_close_change_notification (param i32) (result i32)))
  (import "host" "fs_get_temp_path" (func $host_fs_get_temp_path (param i32 i32 i32) (result i32)))
  (import "host" "fs_get_temp_file_name" (func $host_fs_get_temp_file_name (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "fs_get_current_directory" (func $host_fs_get_current_directory (param i32 i32 i32) (result i32)))
  (import "host" "fs_set_current_directory" (func $host_fs_set_current_directory (param i32 i32) (result i32)))
  (import "host" "fs_get_full_path_name" (func $host_fs_get_full_path_name (param i32 i32 i32 i32 i32) (result i32)))
  ;; Host VFS owns file-API code page, drive assignments, and mounted identity.
  (import "host" "fs_file_api_ansi" (func $host_fs_file_api_ansi (param i32) (result i32)))
  (import "host" "fs_logical_drive_mask" (func $host_fs_logical_drive_mask (result i32)))
  (import "host" "fs_drive_type" (func $host_fs_drive_type (param i32 i32) (result i32)))
  ;; fs_drive_type(rootWA, isWide) → DRIVE_* value, or 0 when no mount claims
  ;; that letter and the caller should keep its built-in answer.
  (import "host" "fs_volume_label" (func $host_fs_volume_label (param i32 i32 i32 i32) (result i32)))
  ;; fs_volume_label(rootWA, isWide, outWA, maxChars) → characters written,
  ;; NUL-terminated; 0 when the drive has no label of its own.
  (import "host" "fs_volume_serial" (func $host_fs_volume_serial (param i32 i32) (result i32)))
  ;; fs_volume_serial(rootWA, isWide) → the mounted volume's serial number, or
  ;; 0 when no mount claims the letter.
  (import "host" "fs_volume_size" (func $host_fs_volume_size (param i32 i32) (result i32)))
  ;; fs_volume_size(rootWA, isWide) → the mounted volume's total size in
  ;; 2048-byte logical blocks (an ISO's own volumeSpaceSize field), or 0 when
  ;; no mounted media claims the letter.
  (import "host" "fs_search_path" (func $host_fs_search_path (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; fs_search_path(pathWA, fileNameWA, extWA, bufLen, bufGA, filePartPtrGA, isWide) → len or 0
  (import "host" "fs_get_short_path_name" (func $host_fs_get_short_path_name (param i32 i32 i32 i32) (result i32)))
  (import "host" "fs_create_file_mapping" (func $host_fs_create_file_mapping (param i32 i32 i32 i32 i32) (result i32)))
  ;; fs_create_file_mapping(hFile, protect, sizeHi, sizeLo, nameWA) → mapping handle
  ;; nameWA is 0 for an unnamed section. A named one can be reopened by name,
  ;; which is how an app asks "is my other instance already running?".
  (import "host" "fs_open_file_mapping" (func $host_fs_open_file_mapping (param i32) (result i32)))
  ;; fs_open_file_mapping(nameWA) → mapping handle, or 0 when no such name exists
  (import "host" "fs_map_view_of_file" (func $host_fs_map_view_of_file (param i32 i32 i32 i32 i32) (result i32)))
  ;; fs_map_view_of_file(hMapping, access, offsetHi, offsetLo, size) → guest addr
  (import "host" "fs_unmap_view" (func $host_fs_unmap_view (param i32) (result i32)))
  ;; fs_unmap_view(baseAddr) → BOOL
  (import "host" "fs_flush_view" (func $host_fs_flush_view (param i32 i32) (result i32)))
  ;; fs_flush_view(addrInsideView, bytes | 0 for the rest of the view) → BOOL
  (import "host" "fs_filetime_to_systemtime" (func $host_fs_filetime_to_systemtime (param i32 i32) (result i32)))
  ;; fs_filetime_to_systemtime(ftWasmAddr, stWasmAddr) → BOOL
  ;; DLL file check (for dynamic LoadLibrary)
  (import "host" "has_dll_file" (func $host_has_dll_file (param i32) (result i32)))
  ;; has_dll_file(nameWA) → 1 if DLL file exists in VFS/host, 0 if not

  ;; COM host imports
  (import "host" "com_create_instance" (func $host_com_create_instance (param i32 i32 i32 i32 i32) (result i32)))
  ;; com_create_instance(rclsidWA, pUnkOuterGA, dwClsContext, riidWA, ppvGA) → HRESULT
  (import "host" "com_register_class_object" (func $host_com_register_class_object (param i32 i32 i32 i32) (result i32)))
  ;; com_register_class_object(rclsidWA, pUnkGA, dwClsContext, flags) → cookie
  (import "host" "com_revoke_class_object" (func $host_com_revoke_class_object (param i32) (result i32)))
  ;; com_revoke_class_object(cookie) → HRESULT
  ;; Returns 0=S_OK, 0x800401F0=CO_E_DLLNOTFOUND (need async load), other=error
  (import "host" "com_get_pending_dll" (func $host_com_get_pending_dll (result i32)))
  (import "host" "com_initialize_thread" (func $host_com_initialize_thread (param i32 i32 i32) (result i32)))
  (import "host" "com_uninitialize_thread" (func $host_com_uninitialize_thread (param i32) (result i32)))
  ;; Thread/event host imports
  ;; create_thread(start, param, stackSize, flags, lpThreadIdWA, creatorTid)
  ;; returns the
  ;; kernel HANDLE and writes the distinct Win32 thread id through the optional
  ;; translated output pointer.
  (import "host" "create_thread" (func $host_create_thread (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "host" "duplicate_current_thread" (func $host_duplicate_current_thread (param i32) (result i32)))
  (import "host" "suspend_thread" (func $host_suspend_thread (param i32) (result i32)))
  (import "host" "resume_thread" (func $host_resume_thread (param i32) (result i32)))
  (import "host" "get_thread_priority" (func $host_get_thread_priority (param i32 i32) (result i32)))
  (import "host" "set_thread_priority" (func $host_set_thread_priority (param i32 i32 i32) (result i32)))
  (import "host" "get_thread_locale" (func $host_get_thread_locale (param i32) (result i32)))
  (import "host" "set_thread_locale" (func $host_set_thread_locale (param i32 i32) (result i32)))
  (import "host" "exit_thread" (func $host_exit_thread (param i32)))
  (import "host" "get_exit_code_thread" (func $host_get_exit_code_thread (param i32) (result i32)))
  (import "host" "terminate_thread" (func $host_terminate_thread (param i32 i32) (result i32)))
  (import "host" "create_event" (func $host_create_event (param i32 i32 i32 i32) (result i32)))
  (import "host" "open_event" (func $host_open_event (param i32 i32) (result i32)))
  (import "host" "set_event" (func $host_set_event (param i32) (result i32)))
  (import "host" "reset_event" (func $host_reset_event (param i32) (result i32)))
  (import "host" "wait_single" (func $host_wait_single (param i32 i32) (result i32)))
  (import "host" "wait_multiple" (func $host_wait_multiple (param i32 i32 i32 i32) (result i32)))
  (import "host" "create_semaphore" (func $host_create_semaphore (param i32 i32) (result i32)))
  (import "host" "release_semaphore" (func $host_release_semaphore (param i32 i32 i32) (result i32)))

  ;; ---- Memory: imported from host, 8192 pages = 512MB initial ----
  ;; Audio output — waveOut bridge to Web Audio API
  (import "host" "wave_out_open" (func $host_wave_out_open (param i32 i32 i32 i32) (result i32)))
  ;; wave_out_open(sampleRate, channels, bitsPerSample, callbackType) → handle
  (import "host" "wave_out_write" (func $host_wave_out_write (param i32 i32 i32) (result i32)))
  ;; wave_out_write(handle, pcmDataWA, byteLength) → 0=ok
  (import "host" "wave_out_schedule_done" (func $host_wave_out_schedule_done (param i32 i32 i32 i32) (result i32)))
  ;; wave_out_schedule_done(handle, waveHdrWA, waveHdrGA, byteLength) → schedules WHDR_DONE/WOM_DONE
  (import "host" "wave_out_reset" (func $host_wave_out_reset (param i32) (result i32)))
  ;; wave_out_reset(handle) → cancels queued playback and flushes WHDR_DONE callbacks
  (import "host" "wave_out_pause" (func $host_wave_out_pause (param i32) (result i32)))
  (import "host" "wave_out_restart" (func $host_wave_out_restart (param i32) (result i32)))
  ;; Pause freezes playback/cursor/completions; restart resumes queued PCM.
  (import "host" "wave_out_close" (func $host_wave_out_close (param i32) (result i32)))
  ;; wave_out_close(handle) → 0=ok
  (import "host" "wave_in_open" (func $host_wave_in_open (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; wave_in_open(rate, channels, bits, callback, instance, callbackType) → handle
  (import "host" "wave_in_close" (func $host_wave_in_close (param i32) (result i32)))
  (import "host" "wave_in_start" (func $host_wave_in_start (param i32) (result i32)))
  (import "host" "wave_in_stop" (func $host_wave_in_stop (param i32) (result i32)))
  (import "host" "wave_in_reset" (func $host_wave_in_reset (param i32) (result i32)))
  (import "host" "wave_in_add_buffer" (func $host_wave_in_add_buffer (param i32 i32 i32 i32 i32) (result i32)))
  ;; wave_in_add_buffer(handle, waveHdrWA, waveHdrGA, dataWA, byteLength) → 0=ok
  (import "host" "wave_out_get_pos" (func $host_wave_out_get_pos (param i32) (result i32)))
  ;; wave_out_get_pos(handle) → bytes played
  (import "host" "wave_out_set_volume" (func $host_wave_out_set_volume (param i32 i32)))
  ;; wave_out_set_volume(handle, volume_0_to_65535)

  ;; Unified voice API — used by both wave_out_* (STREAM) and DSOUND (SNAPSHOT).
  ;; Each voice is one mixer slot in the host AudioContext with its own format
  ;; + gain/pan/playbackRate. waveOut handlers above are now thin shims.
  (import "host" "voice_open" (func $host_voice_open (param i32 i32 i32) (result i32)))
  ;; voice_open(sampleRate, channels, bitsPerSample) → voice_id
  (import "host" "voice_write_stream" (func $host_voice_write_stream (param i32 i32 i32) (result i32)))
  ;; voice_write_stream(id, pcmDataWA, byteLength) → 0
  (import "host" "voice_play_ring" (func $host_voice_play_ring (param i32 i32 i32 i32 i32) (result i32)))
  ;; voice_play_ring(id, pcmDataWA, byteLength, startOffset, loop) → 0
  (import "host" "voice_stop" (func $host_voice_stop (param i32) (result i32)))
  (import "host" "voice_close" (func $host_voice_close (param i32) (result i32)))
  (import "host" "voice_get_pos" (func $host_voice_get_pos (param i32) (result i32)))
  (import "host" "voice_is_playing" (func $host_voice_is_playing (param i32) (result i32)))
  (import "host" "voice_set_volume_linear" (func $host_voice_set_volume_linear (param i32 i32)))
  (import "host" "voice_set_volume_db" (func $host_voice_set_volume_db (param i32 i32)))
  (import "host" "voice_set_pan" (func $host_voice_set_pan (param i32 i32)))
  (import "host" "voice_set_freq" (func $host_voice_set_freq (param i32 i32)))
  ;; DirectSound3D float values cross as raw i32 bit patterns. Property 0/3/8
  ;; carries a vector, 6 cone angles, 11 cone volume, 12/13 distances, 14 mode.
  (import "host" "voice_3d_set" (func $host_voice_3d_set (param i32 i32 i32 i32 i32)))
  (import "host" "voice_3d_get" (func $host_voice_3d_get (param i32 i32) (result i32)))

  ;; --- Virtual LAN wire (docs/virtual-lan-party.md) ---------------------
  ;; The room switch lives in WAT; the host only carries opaque vln/1 frames
  ;; between processes. These three primitives are the whole transport
  ;; surface: hand a frame to the wire, look at the next inbound frame, and
  ;; consume it. Peek and commit are separate so a frame that cannot be
  ;; delivered yet — no receive-ring space — stays queued instead of being
  ;; dropped, which a byte stream may never do.
  ;; net_frame_send(frameWA, len) → 1 accepted, 0 wire queue full
  (import "host" "net_frame_send" (func $host_net_frame_send (param i32 i32) (result i32)))
  ;; net_frame_peek(bufWA, cap) → byte length of the next inbound frame,
  ;; 0 when the wire is empty, -1 when the frame does not fit in cap.
  (import "host" "net_frame_peek" (func $host_net_frame_peek (param i32 i32) (result i32)))
  ;; net_frame_commit() — discard the frame most recently peeked.
  (import "host" "net_frame_commit" (func $host_net_frame_commit))

  (import "host" "memory" (memory 8192 8192 shared))
  (export "memory" (memory 0))

  ;; String constants at WASM offset 0x100
  ;; STRING_CONSTANTS — the low WAT string-constant pool. 0x280 bytes of
  ;; NUL-terminated literals: the ini/help paths, the Find/Open/Save/Font
  ;; common-dialog captions, the MessageBox button labels, the FPU and ordinal
  ;; scratch buffers $win32_dispatch fills in. 171 of the tree's 221 data
  ;; segments used to sit at absolute addresses in NO declared region at all,
  ;; and this pool was most of them -- with no _SIZE global it was invisible to
  ;; tools/wat-memory-map.js and to every overlap gate.
  ;; It ends at VK_SCAN_TABLES; the decoder scratch at 0x1000 is beyond both.
  (global $STRING_CONSTANTS i32 (region.addr $STRING_CONSTANTS 0))
  (global $STRING_CONSTANTS_SIZE i32 (region.size $STRING_CONSTANTS))
  (data (region.addr $STRING_CONSTANTS 0x0) "win.ini\00Help\00[Contents]\00[Back]\00")
  ;; EXE name buffer at 0x120 (max 128 bytes), default "app.exe"
  (data (region.addr $STRING_CONSTANTS 0x20) "app.exe\00")
  ;; WAT-built find/replace dialog labels (consumed by $create_findreplace_dialog).
  ;; All NUL-terminated, lengths recorded next to the offset constants below.
  (data (region.addr $STRING_CONSTANTS 0xA0) "Find what:\00")     ;; +0x00, len 10
  (data (region.addr $STRING_CONSTANTS 0xAB) "Match case\00")     ;; +0x0B, len 10
  (data (region.addr $STRING_CONSTANTS 0xB6) "Direction\00")      ;; +0x16, len 9
  (data (region.addr $STRING_CONSTANTS 0xC0) "Up\00")             ;; +0x20, len 2
  (data (region.addr $STRING_CONSTANTS 0xC3) "Down\00")           ;; +0x23, len 4
  (data (region.addr $STRING_CONSTANTS 0xC8) "Find Next\00")      ;; +0x28, len 9
  (data (region.addr $STRING_CONSTANTS 0xD2) "Cancel\00")         ;; +0x32, len 6
  (data (region.addr $STRING_CONSTANTS 0xD9) "OK\00")             ;; +0x39, len 2  (ShellAbout dialog)
  (data (region.addr $STRING_CONSTANTS 0xDC) "About \00")         ;; +0x3C, len 6  (ShellAbout title prefix)
  (data (region.addr $STRING_CONSTANTS 0xE3) "Find\00")           ;; +0x43, len 4  (Find dialog title)
  ;; -- Open/Save common dialog labels --
  (data (region.addr $STRING_CONSTANTS 0xE8) "Open\00")           ;; +0x48, len 4  (title + button)
  (data (region.addr $STRING_CONSTANTS 0xED) "Save As\00")        ;; +0x4D, len 7
  (data (region.addr $STRING_CONSTANTS 0xF5) "Save\00")           ;; +0x55, len 4  (Save button)
  (data (region.addr $STRING_CONSTANTS 0xFA) "File name:\00")     ;; +0x5A, len 10
  (data (region.addr $STRING_CONSTANTS 0x105) "Look in:\00")       ;; +0x65, len 8
  (data (region.addr $STRING_CONSTANTS 0x10E) "C:\\*\00")          ;; +0x6E, len 4  (default find pattern)
  (data (region.addr $STRING_CONSTANTS 0x113) "C:\\\00")           ;; +0x73, len 3  (default initial dir)
  (data (region.addr $STRING_CONSTANTS 0x117) "..\00")             ;; +0x77, len 2  (parent dir entry)
  (data (region.addr $STRING_CONSTANTS 0x11A) "Upload...\00")      ;; +0x7A, len 9
  (data (region.addr $STRING_CONSTANTS 0x124) "Download\00")       ;; +0x84, len 8
  (data (region.addr $STRING_CONSTANTS 0x12D) "Not implemented yet\00")  ;; +0x8D, len 19 (stub dialog msg)
  (data (region.addr $STRING_CONSTANTS 0x141) "Page Setup\00")     ;; +0xA1, len 10
  (data (region.addr $STRING_CONSTANTS 0x14C) "Print\00")          ;; +0xAC, len 5
  (data (region.addr $STRING_CONSTANTS 0x152) "Color\00")          ;; +0xB2, len 5
  (data (region.addr $STRING_CONSTANTS 0x158) "Font\00")           ;; +0xB8, len 4
  (data (region.addr $STRING_CONSTANTS 0x15D) "Face:\00")          ;; +0xBD, len 5
  (data (region.addr $STRING_CONSTANTS 0x163) "Style:\00")         ;; +0xC3, len 6
  (data (region.addr $STRING_CONSTANTS 0x16A) "Size:\00")          ;; +0xCA, len 5
  (data (region.addr $STRING_CONSTANTS 0x170) "MS Sans Serif\00")  ;; +0xD0, len 13
  (data (region.addr $STRING_CONSTANTS 0x17E) "Arial\00")          ;; +0xDE, len 5
  (data (region.addr $STRING_CONSTANTS 0x184) "Courier New\00")    ;; +0xE4, len 11
  (data (region.addr $STRING_CONSTANTS 0x190) "Times New Roman\00");; +0xF0, len 15
  (data (region.addr $STRING_CONSTANTS 0x1A0) "Regular\00")        ;; +0x100, len 7
  (data (region.addr $STRING_CONSTANTS 0x1A8) "Bold\00")           ;; +0x108, len 4
  (data (region.addr $STRING_CONSTANTS 0x1AD) "Italic\00")         ;; +0x10D, len 6
  (data (region.addr $STRING_CONSTANTS 0x1B4) "Bold Italic\00")    ;; +0x114, len 11
  (data (region.addr $STRING_CONSTANTS 0x1C0) "8\00")              ;; +0x120
  (data (region.addr $STRING_CONSTANTS 0x1C2) "10\00")             ;; +0x122
  (data (region.addr $STRING_CONSTANTS 0x1C5) "12\00")             ;; +0x125
  (data (region.addr $STRING_CONSTANTS 0x1C8) "14\00")             ;; +0x128
  (data (region.addr $STRING_CONSTANTS 0x1CB) "18\00")             ;; +0x12B
  ;; "24" does not fit before the 0x2D0 buffer -- its terminator would land on
  ;; that buffer's first byte -- so it sits after <ord> instead.
  (data (region.addr $STRING_CONSTANTS 0x1E6) "24\00")             ;; +0x146
  ;; Buffer for ordinal-import crash messages: "KERNEL32.#NNNNN\0" (max 16 bytes)
  (data (region.addr $STRING_CONSTANTS 0x1D0) "KERNEL32.#00000\00")  ;; +0x1D0, filled in by $win32_dispatch
  ;; Placeholder name for RESOLVED ordinal imports. thunk+0 holds the ordinal
  ;; tag (bit 31 set), so dispatcher can't treat it as a name RVA for strlen.
  (data (region.addr $STRING_CONSTANTS 0x1E0) "<ord>\00")
  ;; FPU unimplemented opcode message — passed to $crash_unimplemented when an
  ;; x87 escape opcode is decoded but the (group, reg, rm) tuple has no handler.
  (data (region.addr $STRING_CONSTANTS 0x1F0) "FPU_UNIMPL\00")
  ;; 0x200..0x23C USED to hold two packed NUL-separated blobs: the CRT exports
  ;; that stay host-dispatched even with msvcrt.dll loaded, and the import-hint
  ;; correction pair for Funtris's stale "GetMessageA" name on the MessageBoxA
  ;; hint. Both features are alive; neither reads bytes any more. They are
  ;; `"text"` literals now — $str_eq/$lookup_api_id "ceil" in 08b-dll-loader.wat,
  ;; $import_hint_override_api_id in 10-helpers.wat — which the WATX compiler
  ;; interns, dedupes and addresses itself. 60 bytes, no reader, deleted.
  ;; MessageBox button labels — referenced by $create_msgbox_dialog.
  (data (region.addr $STRING_CONSTANTS 0x240) "Abort\00")        ;; len 5  — MB_ABORTRETRYIGNORE
  (data (region.addr $STRING_CONSTANTS 0x246) "Retry\00")        ;; len 5  — MB_ABORTRETRYIGNORE / MB_RETRYCANCEL
  (data (region.addr $STRING_CONSTANTS 0x24C) "Ignore\00")       ;; len 6  — MB_ABORTRETRYIGNORE
  (data (region.addr $STRING_CONSTANTS 0x253) "Yes\00")          ;; len 3  — MB_YESNO / MB_YESNOCANCEL
  (data (region.addr $STRING_CONSTANTS 0x257) "No\00")           ;; len 2  — MB_YESNO / MB_YESNOCANCEL
  (data (region.addr $STRING_CONSTANTS 0x25A) "Try Again\00")    ;; len 9  — MB_CANCELTRYCONTINUE
  (data (region.addr $STRING_CONSTANTS 0x264) "Continue\00")     ;; len 8  — MB_CANCELTRYCONTINUE
  (data (region.addr $STRING_CONSTANTS 0x26D) "uxtheme.dll\00")  ;; optional XP theming DLL
  ;; Stable strings returned by glGetString. Extensions is intentionally empty
  ;; until an optional extension has a complete implementation.
  (data (region.addr $TT_FONT_STRING_STORAGE 0x60) "Wine-Assembly\00")
  (data (region.addr $TT_FONT_STRING_STORAGE 0x70) "WebGL fixed function\00")
  (data (region.addr $TT_FONT_STRING_STORAGE 0x88) "1.1 Wine-Assembly\00")
  (data (region.addr $TT_FONT_STRING_STORAGE 0xA0) "\00")
  ;; WinSock 1.1 ordinal imports used by Win9x DLLs. The DLL loader maps
  ;; supported ordinals to these normal API-table names.
  ;; Every `"text"` literal in this tree interns into one compiler-managed pool.
  ;; This says where that pool lives. Without it the compiler places the pool
  ;; above the last data segment — which is only "above the map" when WATX
  ;; allocated the map itself; here it is the middle of $D3DIM_AUX, measured at
  ;; 0x07B7B040, silently on top of live Direct3D state. See the 2026-08-31
  ;; entry in tools/watx-src/CHANGELOG.md.
  (string.pool $WATX_STRING_POOL)
  ;; The pool's base, as a global, because check-region-decls requires every
  ;; declared region to have one. Nothing reads it: the whole point of the pool
  ;; is that no offset into it is ever written down by hand.
  (global $WATX_STRING_POOL i32 (region.addr $WATX_STRING_POOL 0))
  (global $WATX_STRING_POOL_SIZE i32 (region.size $WATX_STRING_POOL))

  ;; The WSOCK32/WINMM and OLEAUT32 ordinal-import name blocks used to live
  ;; here, as two packed NUL-separated blobs that $dll_ordinal_api_id and
  ;; $system_ordinal_api_id addressed by hand-counted byte offset. Both are
  ;; gone: the names are `"text"` literals at their use sites in
  ;; 08b-dll-loader.wat now, interned into $WATX_STRING_POOL by the compiler.
  ;;
  ;; What went with them is the whole failure mode. Inserting or renaming one
  ;; name shifted every later offset, and the only symptom was an ordinal
  ;; resolving to the WRONG API, in one app, much later — so names could not be
  ;; added where they belonged. The comments deleted along with these blobs
  ;; recorded the damage: "append here rather than inserting above", "fills the
  ;; 18-byte gap ... there is no room to grow it", and a note that Kodak Imaging
  ;; had already lost its imports once to a block placed on top of another. The
  ;; wsock32 name WSAAsyncSelect had been parked inside the OLEAUT32 block for
  ;; want of anywhere else to put it.
  ;; RESERVED_PAGE_STRINGS — the rest of the reserved page, 0x11D80 up to
  ;; GUEST_BASE: the remaining ordinal-import names, the module names
  ;; GetModuleHandle matches, the Win16 built-in module list, the system
  ;; directory, the Hearts NDDE share record and the shell's Run / Shut Down
  ;; dialog text (09c3-controls.wat).
  (global $RESERVED_PAGE_STRINGS i32 (region.addr $RESERVED_PAGE_STRINGS 0))
  (global $RESERVED_PAGE_STRINGS_SIZE i32 (region.size $RESERVED_PAGE_STRINGS))
  (data (region.addr $RESERVED_PAGE_STRINGS 0x0) "ntohl\00WsControl\00")
  ;; if_descr for the one adapter WsControl reports (src/09d-winsock.wat).
  (data (region.addr $RESERVED_PAGE_STRINGS 0x10) "Virtual LAN Adapter\00")
  ;; Console window caption; SetConsoleTitle overwrites it in place.
  (data (region.addr $RESERVED_PAGE_STRINGS 0x24) "Console\00")
  ;; Win98 KERNEL32 ordinal 99 is an unnamed timezone-cache classifier.  Keep
  ;; its diagnostic/API name separate from GetTimeZoneInformation: the native
  ;; ordinal takes a BOOL refresh flag, not an output-structure pointer.
  (data (region.addr $RESERVED_PAGE_STRINGS 0x30) "KERNEL32.dll\00KERNEL32_Ordinal99\00")
  ;; Modules whose exports we dispatch statically: they have no mapped PE
  ;; image and no DLL-table entry, so GetModuleHandle has to recognize them by
  ;; name. Lower case and without the ".dll" suffix; the matcher accepts
  ;; either form. See $guest_name_is_static_system_dll in 09a-handlers.wat.
  ;; ORDER MATTERS: everything from index $STATIC_SYS_DLL_FIRST_DX onwards is
  ;; part of DirectX and answers the file-version query with the DirectX
  ;; version below, so new non-DirectX names belong before "dplayx".
  (data (region.addr $RESERVED_PAGE_STRINGS 0x228) "ole32\00user32\00comctl32\00dplayx\00ddraw\00dsound\00d3drm\00\00")
  ;; Where those modules claim to live, and the suffix appended to the stem.
  (data (region.addr $RESERVED_PAGE_STRINGS 0x25C) "C:\\WINDOWS\\SYSTEM\\\00")
  (data (region.addr $RESERVED_PAGE_STRINGS 0x274) ".dll\00")
  ;; Two more WSOCK32 ordinal names, in the gap that runs to 0x11E30. Jazz
  ;; Jackrabbit 2 imports its whole WinSock set by ordinal and calls
  ;; gethostname during startup, so an unmapped ordinal 57 traps before the
  ;; game reaches its first frame.
  (data (region.addr $RESERVED_PAGE_STRINGS 0x90) "gethostname\00getpeername\00")
  ;; Exports we answer natively even when the real DLL is loaded — see
  ;; $native_override_export_api_id in src/08b-dll-loader.wat.
  (data (region.addr $RESERVED_PAGE_STRINGS 0xB0) "InitCommonControlsEx\00")
  ;; One space, measured by the SysLink layout loop for inter-word advance.
  (data (region.addr $RESERVED_PAGE_STRINGS 0xC8) " \00")
  ;; OLEAUT32 ordinal 420 (see $system_ordinal_api_id).
  (data (region.addr $RESERVED_PAGE_STRINGS 0xD0) "OleCreateFontIndirect\00")
  ;; Win16 module names, matched against an NE imported-name table entry by
  ;; $win16_module_id. NE name tables are upper case, so the compare is exact.
  (data (region.addr $RESERVED_PAGE_STRINGS 0xF0) "KERNEL\00USER\00GDI\00KEYBOARD\00SOUND\00SHELL\00MMSYSTEM\00COMMDLG\00CARDS\00DDEML\00SHELLABOUT\00NDDEAPI\00NDDEGETWINDOW\00WIN87EM\00")
  ;; The machine's NetDDE share database. A DDE share maps a name that clients
  ;; on other machines ask for onto the local application and topic that
  ;; actually serves it, and on a real Win98 box it is written at install time
  ;; and belongs to the MACHINE, not to the app — Hearts never creates its own
  ;; (it imports no NDDEAPI entry and only LoadLibrarys it for NDdeGetWindow).
  ;; So this is a table of what a Win98 install ships, not a special case: a
  ;; remote Hearts asks for topic "Hearts$" on \\SOMEBODY\NDDE$, and that share
  ;; is what says the local server is application "MSHearts" topic "Hearts".
  ;; Records are share, application, topic; an empty share ends the table.
  ;; The faces GDI here can actually rasterize — the .FON strikes mounted by
  ;; fonts/substitutions.json. EnumFonts reports these and nothing else.
  ;; Not at 0x11500: that is the oleaut32 ordinal-name block above, and the
  ;; later segment wins, so placing them together cost Kodak Imaging its
  ;; BSTR/VARIANT imports.
  ;; 48 bytes ending in the empty string that terminates the run; its own
  ;; region (globals in 09e-win16-api.wat, which reads it) because it is
  ;; neither a class name nor part of the reserved page.
  (data (region.addr $WIN16_FONT_FACES 0) "System\00MS Sans Serif\00Fixedsys\00Courier\00Terminal\00\00")
  ;; MMSYSTEM entry points asked for by name rather than imported. A module
  ;; this emulator answers for has no export table to read, so GetProcAddress
  ;; needs the name-to-ordinal mapping written down — see
  ;; $win16_mmsystem_ordinal. Chip's Challenge asks for exactly these five
  ;; before it will start.
  ;;
  ;; Each entry is a length byte, the name, and the ordinal as a word; a zero
  ;; length ends the list. Upper case, because $win16_cstr_to_pstr folds the
  ;; caller's name that way before any lookup — the same form the tables in
  ;; src/win16-ordinals.generated.json use.
  (data (region.addr $WIN16_MMSYSTEM_NAMES 0)
    "\0cSNDPLAYSOUND\02\00"
    "\0eMCISENDCOMMAND\bd\02"
    "\11MCIGETERRORSTRING\c2\02"
    "\11MIDIOUTGETNUMDEVS\c9\00"
    "\11WAVEOUTGETNUMDEVS\91\01"
    "\00")
  ;; The same shape for the entry points apps look up in KERNEL, GDI and USER
  ;; by name rather than importing. A module this emulator answers for has no
  ;; export table to search, so the name has to be matched here and turned into
  ;; an ordinal — see $win16_builtin_ordinal. JigSawed asks GDI for
  ;; CreateRectRgn before it will draw its board.
  ;;
  ;; The word after each name is the ordinal with the module number in its top
  ;; nibble (1 KERNEL, 2 USER, 3 GDI), because one table serves all three and
  ;; ordinals collide across them — GDI.47 and KERNEL.47 are different calls.
  ;; No Win16 ordinal reaches 4096, so the nibble is free.
  ;;
  ;; Every name here is one a game in the corpus actually asks for: Visual
  ;; Basic's Declare statement is a GetProcAddress by name, and a NULL comes
  ;; back to the program as "Sub or Function not defined".
  (data (region.addr $WIN16_BUILTIN_NAMES 0)
    "\0dCREATERECTRGN\40\30"
    "\15CREATERECTRGNINDIRECT\41\30"
    "\0eGETSTOCKOBJECT\57\30"
    "\0bRECTVISIBLE\68\30"
    "\0dGETDEVICECAPS\50\30"
    "\06BITBLT\22\30"
    "\0aSHOWCURSOR\47\20"
    "\07SETRECT\48\20"
    "\09UNIONRECT\50\20"
    "\12CREATECOMPATIBLEDC\34\30"
    "\16CREATECOMPATIBLEBITMAP\33\30"
    "\08DELETEDC\44\30"
    "\0cDELETEOBJECT\45\30"
    "\0cSELECTOBJECT\2d\30"
    "\0aSTRETCHBLT\23\30"
    "\0aSETRECTRGN\ac\30"
    "\0dSELECTCLIPRGN\2c\30"
    "\0aCOMBINERGN\2f\30"
    "\0aPTINREGION\a1\30"
    "\08FRAMERGN\29\30"
    "\08DRAWICON\54\20"
    "\07ELLIPSE\18\30"
    "\08GETFOCUS\17\20"
    "\07GETMENU\9d\20"
    "\0aGETSUBMENU\9f\20"
    "\09OFFSETRGN\65\30"
    "\07POLYGON\24\30"
    "\0eTRACKPOPUPMENU\a0\21"
    "\07WINHELP\ab\20"
    "\0fGETMODULEHANDLE\2f\10"
    "\11GETMODULEFILENAME\31\10"
    "\14GETPRIVATEPROFILEINT\7f\10\10LOADLIBRARYEX32W\01\12\0eFREELIBRARY32W\02\12\11GETPROCADDRESS32W\03\12\10GETVDMPOINTER32W\04\12\0bCALLPROC32W\05\12"
    "\00")
  (data (region.addr $RESERVED_PAGE_STRINGS 0x160) "Hearts$\00MSHearts\00Hearts\00\00")
  ;; MessageBox system strings mirrored in the WAT-owned reserved page just
  ;; below guest memory. The legacy low-page copies above are kept for older
  ;; dialog helpers, but apps can disturb that scratch/null-page area during
  ;; execution; MessageBox must copy from stable USER-owned storage.
  ;; USER_DIALOG_STRINGS — the MessageBox button labels, the common-dialog
  ;; captions and the Print/Colour dialog text, mirrored in the WAT-owned
  ;; reserved page just below guest memory. The low STRING_CONSTANTS copies
  ;; are kept for older helpers, but apps can disturb that scratch area at
  ;; run time; these must come from storage nothing else writes. Runs up to
  ;; DX_VERSION_INFO.
  (global $USER_DIALOG_STRINGS i32 (region.addr $USER_DIALOG_STRINGS 0))
  (global $USER_DIALOG_STRINGS_SIZE i32 (region.size $USER_DIALOG_STRINGS))
  (data (region.addr $USER_DIALOG_STRINGS 0x0) "OK\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x3) "Cancel\00")
  (data (region.addr $USER_DIALOG_STRINGS 0xA) "Abort\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x10) "Retry\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x16) "Ignore\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1D) "Yes\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x21) "No\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x24) "Try Again\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x2E) "Continue\00")

  ;; Open/Save common-dialog strings also live in the stable reserved page.
  ;; The legacy low-page copies above are scratch-adjacent and can be
  ;; disturbed by long-running apps before they invoke GetOpenFileNameA.
  (data (region.addr $USER_DIALOG_STRINGS 0x37) "Open\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x3C) "Save As\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x44) "Save\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x49) "File name:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x54) "Look in:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x5D) "C:\\*\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x62) "C:\\\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x66) "..\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x69) "Upload...\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x73) "Download\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x7C) "Files of type:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0xC6) "Microsoft Windows\0AWindows 98\0ACopyright (C) 1981-1998 Microsoft Corp.\00")
  ;; Find/Replace labels live in the stable USER-owned string page because
  ;; the modeless dialog can outlive app use of the low scratch page.
  (data (region.addr $USER_DIALOG_STRINGS 0x120) "Find what:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x12B) "Replace with:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x139) "Match case\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x144) "Direction\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x14E) "Up\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x151) "Down\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x156) "Find Next\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x160) "Replace\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x168) "Replace All\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x17B) "Find\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x188) "Printer: Web Printer\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x19D) "Page range\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1A8) "All\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1AC) "From:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1B2) "To:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1B6) "Copies:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1BE) "Margins (inches)\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1CF) "Left:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1D5) "Top:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1DA) "Right:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1E1) "Bottom:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x1E9) "Paper: Letter 8.5 x 11 in\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x203) "1.00\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x208) "Pages\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x20E) "1\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x210) "9999\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x215) "Back\00Next\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x220) "WINSPOOL\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x229) "Web Printer\00")
  ;; ChooseColor labels from the classic partial color-dialog template.
  (data (region.addr $USER_DIALOG_STRINGS 0x235) "Basic colors:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x243) "Custom colors:\00")
  (data (region.addr $USER_DIALOG_STRINGS 0x252) "Define Custom Colors >>\00")

  ;; Classic shell folder-picker text. Keep it in WAT-owned storage because
  ;; the dialog remains live while the calling thread is parked in the modal
  ;; pump; low-page scratch strings are application-writable during that time.
  (global $BROWSE_DIALOG_STRINGS i32 (region.addr $BROWSE_DIALOG_STRINGS 0))
  (global $BROWSE_DIALOG_STRINGS_SIZE i32 (region.size $BROWSE_DIALOG_STRINGS))
  (data (region.addr $BROWSE_DIALOG_STRINGS 0x00) "Browse for Folder\00")
  (data (region.addr $BROWSE_DIALOG_STRINGS 0x12) "Desktop\00")
  (data (region.addr $BROWSE_DIALOG_STRINGS 0x1A) "My Computer\00")
  (data (region.addr $BROWSE_DIALOG_STRINGS 0x26) "Network Neighborhood\00")
  (data (region.addr $BROWSE_DIALOG_STRINGS 0x3B) "My Documents\00")
  (data (region.addr $BROWSE_DIALOG_STRINGS 0x48) "C:\\My Documents\00")

  ;; A complete VS_VERSIONINFO block (header + VS_FIXEDFILEINFO, no string
  ;; tables) reporting DirectX 6.1a — dplayx.dll 4.06.03.0518, the version
  ;; Windows 98 SE shipped. The file-version APIs hand this back for the
  ;; DirectX modules we dispatch statically, which have no file on disk to
  ;; read a real resource out of. Age of Empires II refuses to start below
  ;; 4.6.3.516, and it asks dplayx, not the display driver.
  ;;   +0x00 wLength=92  wValueLength=52  wType=0
  ;;   +0x06 "VS_VERSION_INFO" UTF-16 + NUL, then 2 bytes of padding
  ;;   +0x28 VS_FIXEDFILEINFO: signature, struct version, file/product
  ;;         version, flags mask, flags, VOS__WINDOWS32, VFT_DLL, dates
  (data (region.addr $DX_VERSION_INFO 0)
    "\5c\00\34\00\00\00"
    "V\00S\00_\00V\00E\00R\00S\00I\00O\00N\00_\00I\00N\00F\00O\00\00\00"
    "\00\00"
    "\bd\04\ef\fe\00\00\01\00"
    "\06\00\04\00\06\02\03\00"
    "\06\00\04\00\06\02\03\00"
    "\3f\00\00\00\00\00\00\00"
    "\04\00\00\00\02\00\00\00"
    "\00\00\00\00\00\00\00\00\00\00\00\00")

  ;; Dialog-template string class names. Win32 templates may use either
  ;; builtin ordinal classes (0x80..0x85) or string names.
  (data (region.addr $CLASS_NAME_STRINGS 0) "Button\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x08) "Edit\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x0D) "Static\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x14) "ListBox\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x1C) "ScrollBar\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x26) "ComboBox\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x2F) "msctls_progress32\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x41) "SysListView32\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x50) "Slider1\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x58) "msctls_trackbar32\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x6A) "SysTreeView32\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x78) "SysLink\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x80) "DirectAnimation.DAView\00")
  (data (region.addr $CLASS_NAME_STRINGS 0xA0) "DirectAnimation.DAStatics\00")
  (data (region.addr $CLASS_NAME_STRINGS 0xC0) "ImportImage\00")
  (data (region.addr $CLASS_NAME_STRINGS 0xD0) "ImportSound\00")
  (data (region.addr $CLASS_NAME_STRINGS 0xE0) "ModifiableBehavior\00")
  (data (region.addr $CLASS_NAME_STRINGS 0xF8) "NumberB\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x100) "StringB\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x108) "Compose2\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x114) "DetectCollision\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x128) "StartModel\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x134) "Tick\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x13C) "Pause\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x144) "SetRenderTimeout\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x160) "msctls_statusbar32\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x174) "ToolbarWindow32\00")
  (data (region.addr $CLASS_NAME_STRINGS 0x188) "MS Sans Serif\00")
  ;; Default 16-bpp BI_RGB channel masks (RGB555). BI_BITFIELDS callers carry
  ;; their own validated mask triplet; DirectDraw explicitly requests RGB565.
  ;; Three dwords, and NOT a string -- its own region rather than a tail on
  ;; CLASS_NAME_STRINGS, which is what the block on either side of it is.
  (global $DIB_DEFAULT_RGB555_MASKS i32 (region.addr $DIB_DEFAULT_RGB555_MASKS 0))
  (global $DIB_DEFAULT_RGB555_MASKS_SIZE i32 (region.size $DIB_DEFAULT_RGB555_MASKS))
  (data (region.addr $DIB_DEFAULT_RGB555_MASKS 0) "\00\7c\00\00\e0\03\00\00\1f\00\00\00")

  ;; OLE_STRINGS: the clipboard-format names, the two server-less ProgIDs and
  ;; the Insert Object dialog's own text, 0x32B0 up to ENV_DEFAULTS. A
  ;; separate region from the class names because 09a7b-ole.wat is what reads
  ;; every one of them.
  (global $OLE_STRINGS i32 (region.addr $OLE_STRINGS 0))
  (global $OLE_STRINGS_SIZE i32 (region.size $OLE_STRINGS))
  ;; The two registered clipboard formats that carry an embedded OLE object.
  ;; OleCreateFromData looks for these on a source data object and declines with
  ;; DV_E_FORMATETC when neither is there, which is what sends a container down
  ;; its static-picture path instead.
  (data (region.addr $OLE_STRINGS 0x00) "Embed Source\00")      ;; 0x32B0 Embed Source
  (data (region.addr $OLE_STRINGS 0x10) "Embedded Object\00")   ;; 0x32C0 Embedded Object
  ;; ProgIDs of the two server-less object classes OLE defines itself.
  (data (region.addr $OLE_STRINGS 0x20) "StaticMetafile\00")    ;; 0x32D0 StaticMetafile
  (data (region.addr $OLE_STRINGS 0x30) "StaticDib\00")         ;; 0x32E0 StaticDib

  ;; Insert Object dialog. The object-type list is built by walking
  ;; HKEY_CLASSES_ROOT\CLSID for subkeys that carry an Insertable key, which is
  ;; how Windows decides what may be embedded.
  (data (region.addr $OLE_STRINGS 0x40) "CLSID\00")             ;; 0x32F0 CLSID
  (data (region.addr $OLE_STRINGS 0x50) "Insertable\00")        ;; 0x3300 Insertable
  (data (region.addr $OLE_STRINGS 0x60) "Insert Object\00")     ;; 0x3310 Insert Object
  (data (region.addr $OLE_STRINGS 0x70) "Object Type:\00")      ;; 0x3320 Object Type:
  (data (region.addr $OLE_STRINGS 0x80) "Create New\00")        ;; 0x3330 Create New
  (data (region.addr $OLE_STRINGS 0x90) "Create from File\00")  ;; 0x3340 Create from File
  (data (region.addr $OLE_STRINGS 0xA8) "OK\00")                ;; 0x3358 OK
  (data (region.addr $OLE_STRINGS 0xB0) "Cancel\00")            ;; 0x3360 Cancel
  ;; Shown when no server is registered, which is the state of a machine with
  ;; no OLE applications installed -- Windows shows an empty list there too.
  (data (region.addr $OLE_STRINGS 0xC0) "(no object types registered)\00") ;; 0x3370 (no object types registered)

  ;; ENV_DEFAULTS: 192 bytes, exactly the run below. $env_ensure copies it
  ;; into the guest heap and then appends LAUNCH_ENV_OVERRIDES over its final
  ;; NUL, so the two together are the environment an app is handed.
  (global $ENV_DEFAULTS i32 (region.addr $ENV_DEFAULTS 0))
  (global $ENV_DEFAULTS_SIZE i32 (region.size $ENV_DEFAULTS))
  ;; ENV_DEFAULTS — the process environment a freshly booted Win98 hands an
  ;; app, as one "NAME=VALUE\0"... run ending in a second NUL. Copied into the
  ;; guest heap on first use; see $env_ensure.
  (data (region.addr $ENV_DEFAULTS 0) "COMSPEC=C:\\COMMAND.COM\00TEMP=C:\\WINDOWS\\TEMP\00TMP=C:\\WINDOWS\\TEMP\00windir=C:\\WINDOWS\00SystemDrive=C:\00APPDATA=C:\\WINDOWS\\Application Data\00USERPROFILE=C:\\WINDOWS\00PATH=C:\\WINDOWS;C:\\WINDOWS\\COMMAND\00\00")

  ;; ============================================================
  ;; MEMORY MAP
  ;; ============================================================
  ;; 0x00000000  4KB     Null page
  ;; 0x00001000  4KB     Decoder scratch / ModRM result area
  ;; 0x00002000  4KB     UPDATE_RECT    (256 entries × 16 bytes — WAT-owned update bbox)
  ;; 0x00003000  256B    UPDATE_FLAGS   (1 byte per window slot, non-empty update state)
  ;; 0x00003100  128B    CLASS_NAME_STRINGS (built-in control class names)
  ;; 0x00003390  ~370B   ENV_DEFAULTS (initial environment block template)
  ;; 0x00003500  1KB     WND_BG_BRUSH_TABLE (256 × 4 bytes — class hbrBackground per hwnd)
  ;; 0x00003900  1KB     WND_CLASS_CURSOR_TABLE (256 × 4 bytes — class hCursor per hwnd)
  ;; 0x00003D00  256B    CLASS_EXTRA_TABLE (64 × 4 bytes — cbClsExtra per class slot)
  ;; 0x00003E00   48B    WIN16_FONT_FACES (face names EnumFonts reports)
  ;; 0x00003E30  ~464B   Win16 dynamic GetProcAddress name tables
  ;; 0x00004000  4KB     DIALOG_STATE_TABLE (256 entries x 16 bytes)
  ;; 0x00005000  256B    WINDOW_UNICODE_TABLE (one byte per WND_RECORDS slot)
  ;; 0x00005100  4B      SHARED_PROCESS_ID (shared by every thread instance)
  ;; 0x00005104  8B      SHARED_DLG_ENDED / SHARED_DLG_RESULT
  ;; 0x0000510C  4B      SHARED_DLG_PUMP_HWND (modal pump hwnd, all instances)
  ;; 0x00005110  240B    LAUNCH_ENV_OVERRIDES (host-supplied NAME=VALUE entries)
  ;; 0x00005200  4KB     WINDOW_EXTRA_TABLE (256 entries x 16 bytes)
  ;; 0x00006200  1KB     ATOM_LOCAL_TABLE  (128 entries × 8 bytes — AddAtom namespace)
  ;; 0x00006600  1KB     ATOM_GLOBAL_TABLE (128 entries × 8 bytes — GlobalAddAtom namespace)
  ;; 0x00006A00  1KB     CLIPFORMAT_TABLE (128 entries × 8 bytes — RegisterClipboardFormat)
  ;; 0x00006E00  256B    PAINT_SCRATCH  (ring of 16 RECTs for painting wndprocs)
  ;; 0x00006F00  256B    WND_CLASS_SLOT_TABLE (256 × 1 byte — class record per window slot)
  ;; 0x00007000  6KB     WND_RECORDS    (256 entries × 24 bytes, ends 0x8800)
  ;; 0x00008800  4KB     CONTROL_TABLE  (256 entries × 16 bytes, ends 0x9800)
  ;; 0x00009800  2KB     CONTROL_GEOM   (256 entries × 8 bytes,  ends 0xA000)
  ;; 0x0000A000  3KB     CLASS_RECORDS  (64  entries × 48 bytes, ends 0xAC00)
  ;; 0x0000AC00  320B    TIMER_TABLE    (16  entries × 20 bytes, ends 0xAD40)
  ;; 0x0000AD40  32B     Free (former PAINT_SCRATCH, now a ring at 0x6E00)
  ;; 0x0000AD60  1KB     MENU_DATA_TABLE (256 × 4 bytes — heap ptr to per-window menu blob)
  ;; 0x0000B160  8KB     WND_DLG_RECORDS (256 × 32 bytes — dialog header state per slot, ends 0xD160)
  ;; 0x0000D160  16B     WAVE_OUT_STATE (shared waveOut callback info for cross-thread access)
  ;; 0x0000D170  6KB     SCROLL_TABLE   (256 entries × 24 bytes, ends 0xE970)
  ;; 0x0000E970  256B    FLASH_TABLE    (256 entries × 1 byte,  ends 0xEA70)
  ;; 0x0000EA70  1KB     NC_FLAGS       (256 entries × 4 bytes, ends 0xEE70)
  ;;   bit 0: WM_NCPAINT pending; bit 1: WM_ERASEBKGND pending; bit 2: WM_NCCALCSIZE pending
  ;; 0x0000EE70  2KB     TITLE_TABLE    (256 entries × 8 bytes — WASM title ptr + len, ends 0xF670)
  ;; 0x0000F670  4KB     CLIENT_RECT    (256 entries × 16 bytes — l/t/r/b i32, ends 0x10670)
  ;; 0x00010670  256B    SHOW_STATE_TABLE (256 × 1 byte — bit 0 maximized, bit 1 minimized, ends 0x10770)
  ;; 0x00010770  32B     WINDOW_REGION_BITS (256 × 1 bit — SetWindowRgn state, ends 0x10790)
  ;; 0x00010790  32B     NATIVE_STATUS_BITS (one bit per WND_RECORDS slot)
  ;; 0x000107B0  32B     NATIVE_TAB_BITS (one bit per WND_RECORDS slot)
  ;; 0x000107D0  12B     SHARED_MODAL_DLG_HWND / RESULT / DONE
  ;; 0x000107DC  36B     Free
  ;; 0x00010800  256B    IRQ_SAVE_STACK (interrupt reg save area, 36 bytes/frame, ~7 deep)
  ;; 0x00010900  256B    CALLSTACK_RING (64 slots × 4 bytes — shadow ret_addr stack for --trace-callstack)
  ;; 0x00010A00  256B    MCI_DEVICE_TABLE (16 × 16 bytes — host-backed MCI devices)
  ;; 0x00010B00  1KB     OWNER_TABLE   (256 entries × 4 bytes, ends 0x10F00)
  ;; 0x00010F00  256B    WND_CLASS_ICON_TABLE (64 × 4 bytes — WNDCLASS.hIcon per class slot)
  ;; 0x00011000  320B    WAT-owned system strings
  ;; 0x00011140  448B    DX_PRESENT_BMI (BITMAPINFOHEADER + palette/masks)
  ;; 0x00011300  220B    WSOCK32 ordinal-import names (ends 0x000113DC)
  ;; 0x000113DC  36B     Free
  ;; 0x00011400 256B     DI_DIK_VK_TABLE (DirectInput scancode → VK, 09a8-handlers-directx.wat)
  ;; 0x00011568  24B     Free
  ;; 0x00011580  1KB     RICHEDIT_FORMAT_TABLE (256 × 4 bytes — latest CFM_SIZE yHeight)
  ;; 0x00011980  1KB     RICHEDIT_PARA_TABLE (256 × 4 bytes — heap ptr to PARAFORMAT cache)
  ;; 0x00011D80  36B     WSOCK32 ordinal names (cont.) + WsControl if_descr
  ;; 0x00011DA4  128B    CONSOLE_TITLE (window caption for the console)
  ;; 0x00011E30   32B    Native-override export names (InitCommonControlsEx)
  ;; 0x00011E48    8B    SysLink space literal
  ;; 0x00011E50   32B    OLEAUT32 ordinal-import names
  ;; 0x00011E70   60B    Win16 module names (KERNEL/USER/GDI/... , ends 0x11EAC)
  ;; 0x00011EAC   84B    Free
  ;; 0x00011F00  166B    Run-dialog strings (src/09c3-controls.wat), ends 0x11FA6
  ;; --- High WAT-private tables ---
  ;; 0x079DA000  16KB    WIN16_SEG_TABLE (960 selectors × 16 bytes + scratch)
  ;; 0x079C7000   4KB    free (former undersized WIN16_THUNK_TABLE placement)
  ;; 0x079D0000  32KB    GDI_NEAREST_CACHE (4096 × {colour tag, palette index})
  ;; 0x079D8000   8KB    WIN16_THUNK_TABLE (2048 entries × 4 bytes)
  ;; 0x07E00000  32KB    API dispatch hash table
  ;; 0x07E08000   1KB    TEXT_SCRATCH (Unicode-to-ANSI conversion)
  ;; 0x07E09000 12KB     CONSOLE_TEXT (6144 cells × 2 bytes)
  ;; 0x07E0C000 12KB     CONSOLE_ATTR (6144 cells × 2 bytes)
  ;; 0x07E0F000  4KB     CONSOLE_INPUT (queue, buffers, handle aliases, title)
  ;; 0x07E10000 16KB     DIB_PAGE_USED
  ;; 0x07E14000 32KB     DIB_PAGE_RUNS
  ;; 0x07E1C000 832KB    GDI_REGION_BANDS (256 x 208 RECT slots)
  ;; 0x079CA000 512B     WIN16_BUILTIN_NAMES (KERNEL/USER/GDI by-name exports)
  ;; 0x079C8000  1KB     WND_Z_ORDER_TABLE (256 × 4-byte sibling z ranks)
  ;; 0x079C9C00  1KB     WND_HINSTANCE_TABLE (256 × 4-byte creating HINSTANCE)
  ;; 0x079CC400  1KB     WND_THREAD_TABLE (256 × 4-byte owning thread id)
  ;; 0x079CC800 8320B    THREAD_MSG_QUEUES (8 tids × 64-entry MSG ring)
  ;; 0x07EEC000 13KB     GDI_REGION_WORK (4 x 208 RECT buffers)
  ;; 0x07EF0000 2KB      GDI_DC_CLIP_TABLE (256 x {HDC, owned HRGN})
  ;; 0x07EF0800 2KB      GDI_DC_SAVE_TABLE (256 x {HDC, meta guest pointer})
  ;; 0x07EF1000 80B      GDI_LINE_DESC scratch
  ;; 0x07EF1100 160B     GDI_BLIT_DESC scratch
  ;; 0x07EF11A0 304B     GDI_BITMAP_PLAN/name scratch
  ;; 0x07EF12D0  16B     WINDOW_RECT_SCRATCH (window geometry queries)
  ;; 0x07EF12E0  80B     GDI_BRUSH_DESC scratch
  ;; 0x07EF1730   4B     GDI_OBJECT_GEN (object-table generation counter)
  ;; 0x07EF1734   4B     GDI_WINDOW_SURFACE_HWM (window-surface high-water mark)
  ;; GDI_DC_STATE_TABLE (512 x 96-byte canonical DC state; compiler-placed)
  ;; GDI_OBJECT_TABLE (512 x 48-byte object records; compiler-placed)
  ;; 0x07EFA800 8KB      GDI_WINDOW_SURFACE_TABLE (256 x 32-byte records)
  ;; 0x07EFC800 8KB      GDI_DC_AUX_TABLE (256 x 32-byte extended DC state)
  ;; 0x07EFE800 6KB      GDI_COLOR_ADJUST_TABLE (256 x 24-byte structures)
  ;; 0x07F00400  3KB     PROP_TABLE (256 entries × 12 bytes)
  ;; 0x07F01000  256B    PAINT_FLAGS (1 byte per window slot)
  ;; 0x07F01200  256B    TAB_NATIVE_STATE_TABLE (32 × {hwnd, mirror state ptr})
  ;; 0x07F01300  256B    ICON_TABLE (32 entries × {hInstance, resource id})
  ;; 0x07F01400  768B    CURSOR_TABLE (32 × ICONINFO + pushed flag)
  ;; 0x07F01700  160B    CURSOR_MASK_DESC + CURSOR_COLOR_DESC (two 80B surfaces)
  ;; 0x07F01800  3KB     EDIT_LAYOUT_SCRATCH (384 entries × 8 bytes)
  ;; 0x07F02400 16B      VIRTUAL_MAP_STATE (count, backing bump pointer)
  ;; 0x07F02410 32KB     VIRTUAL_MAP_TABLE (2048 entries x 16 bytes)
  ;; 0x07F0A420 4B       GDI_BITMAP_FONT_IO (filesystem read count)
  ;; 0x07F0A440 80B      GDI_BITMAP_FONT_DESC (surface scratch)
  ;; 0x07F0A600 192B     GDI_BITMAP_FONT_LRU (last-use stamp per strike slot)
  ;; 0x07F0A800 3KB      GDI_BITMAP_FONT_TABLE (48 strikes x 64 bytes)
  ;; 0x07F0B400 2KB      TT_SUBST_TABLE (font substitution, see 10c-truetype.wat)
  ;; 0x07F0BC00 768B     TT_SUBST_ALIAS_TABLE
  ;; 0x07F0C000 2KB      GDI_DC_SYSTEM_CLIP_TABLE (256 x {HDC, owned HRGN})
  ;; 0x07F0C800 64B      HEAP_SHARED (low-heap chunk cursor, heap_base)
  ;; 0x07F0C840 512B     LOCK_TABLE (cross-instance mutexes, one 64B line each)
  ;; 0x07F0CA40 1KB      CS_TABLE (256 CRITICAL_SECTIONs, WASM addresses)
  ;; 0x07F0CE40 16B      SHARED_COUNTERS (process-wide state; +0 class atom,
  ;;                                     +4 decoded-code cache generation)
  ;; 0x07F0CE60 16B      GDI_TABLE_MARKS (high-water slot counts, 3 used)
  ;; The three TV_* tables below were at 0x07F0C900/0x07F0C904/0x07F0CA00 on
  ;; main. They move here on the merge into the threads branch, which grew
  ;; LOCK_TABLE and CS_TABLE over exactly those addresses. Neither side
  ;; conflicts textually, so git merges both cleanly and the build still
  ;; passes -- the only symptom is a lock line and a TreeView's scroll state
  ;; writing over each other at runtime. 0x07F0CE70..0x07F0D000 is what is
  ;; left under GDI_REGION_TABLE.
  ;; 0x07F0CE80   4B     TV_SLOT_MARK (one past the highest TV_TABLE slot used)
  ;; 0x07F0CE84   4B     TV_HANDLE_SEQ (item-handle sequence, shared by threads)
  ;; 0x07F0CE90  32B     DX_PROCESS_STATE (display/cooperative state shared by threads)
  ;; 0x07F0CEE0   4B     LOOP_PROCESS_STATE (copy-superop opt-in shared by threads)
  ;; 0x07F0CF00 256B     TV_VIEW_TABLE (16 x per-TreeView caret/scroll/imagelist)
  ;; 0x07F0D000 8KB      GDI_REGION_TABLE (256 WAT-owned HRGN records)
  ;; 0x07F0F000 4KB      GDI_DC_PATH_TABLE (256 x 16-byte WAT path records)
  ;; 0x07F10000 4KB      HANDLER_HIST_COUNTS (1024 i32 counters)
  ;; 0x07F11000 4KB      free (former DX_SURF_PAL)
  ;; 0x07F12000 8KB      CODE_PAGE_BITMAP (1 bit per 4KB guest page < 0x10000000)
  ;; 0x07F14000 8KB      SYNC_TABLE (512 entries × 16 bytes)
  ;; 0x07F16000 16KB     D3DIM_VIEWPORT_LIGHT_HEAD (4096 light-list heads)
  ;; 0x07F1A000 24KB     free (former DX_SURF_STATE / DX_CURSOR_SAVE)
  ;; 0x07F20000  256B    HIT_COUNT_BASE (16 --count slots of {addr, count})
  ;; 0x07F20100   80B    TIMER_SHARED (active count, next auto id, 16 owner tids)
  ;; 0x07F20200  256B    EXTRA_CMDLINE_BUFFER (JS-provided arguments)
  ;; 0x07F20300   64B    TLS_NEXT_INDEX_SHARED (process TLS index cursor/cache line)
  ;; 0x07F20400  280B    DI_MOUSE_INPUT_STATE (dx/dy + 64 events + overflow X/Y)
  ;; 0x07F21000    4KB   SCROLL_AUX_TABLE (256 entries × 16 bytes)
  ;; allocator-owned 256B SCROLL_ARROW_TABLE (one packed ESB_* byte per window)
  ;; 0x07F22000   16KB   TV_TABLE (512 entries × 32 bytes)
  ;; 0x07F26000    4KB   TV_IMAGE_TABLE (512 entries × {image, selected image})
  ;; 0x07F27000    2KB   TV_OWNER_TABLE (owning hwnd per TV_TABLE item)
  ;; 0x07F28000   32KB   DX_SURF_META (4096 × {creation caps,parent slot+1})
  ;; 0x07F30000 8KB      OP_INDEX (2048 decode-time op-start addresses)
  ;; 0x07F32000 16KB     DX_SURF_PAL (4096 per-surface palette pointers)
  ;; 0x07F36000 128KB    DX_SURF_STATE (4096 entries × 32 bytes)
  ;; 0x07F56000 32KB     DX_CURSOR_SAVE (4096 cursor-cache pointers/markers)
  ;; 0x07F5E000 8KB      free/alignment
  ;; 0x07F60000 128KB    DX_OBJECTS (4096 entries × 32 bytes)
  ;; 0x07F80000 32KB     COM_WRAPPERS (4096 entries × 8 bytes)
  ;; 0x07F88000 16KB     DX_SURF_FMT (4096 per-surface pixel-format kinds)
  ;; 0x07F8C000 16KB     DX_SURF_OWNER (4096 DirectDraw owner slot+1 values)
  ;; 0x07F90000  4KB     free
  ;; 0x07F16000 492KB    (packed apart from the gaps listed above -- former
  ;;                      HANDLER_PAIR_HIST_COUNTS home, too
  ;;                      small once the handler table passed 361. This block is
  ;;                      packed wall-to-wall with the branch/hot-block tables
  ;;                      below, so the matrix could not grow in place; it now
  ;;                      lives at 0x04000000, in the unused 16MB gap under
  ;;                      THREAD_CACHE_BASE. Not 0x08000000 -- that is
  ;;                      VIRTUAL_BACKING_BASE.)
  ;; 0x07F91000 4KB      BRANCH_CMP_JCC_HIST (16 cc x 64 reg-pair counters)
  ;; 0x07F92000 4KB      BRANCH_TEST_JCC_HIST (16 cc x 64 reg-pair counters)
  ;; 0x07F93000 32KB     BRANCH_ALU_M32_RO_JCC_HIST (16 cc x 512 op/reg/base counters)
  ;; 0x07F9B000 256KB    HOT_BLOCK_HIST (32768 entries x {eip,count})
  ;; 0x07FDB000 64KB     SIB_CONSUMER_HIST (8192 entries x {key,count})
  ;; 0x07FEB000  4KB     D3DIM auxiliary strings/caches/state
  ;; --- Remaining DX tables in high memory, outside guest address space ---
  ;; 0x07FEC000 16KB     D3DIM_MATRICES (256 entries × 64 bytes, ends 0x07FF0000)
  ;; 0x07FFA000 15.75KB  COM_WRAPPERS_AUX (2015 × 8B + 4B tail pad, ends 0x07FFDEFC)
  ;; 0x07FFDEFC  260B    DX_VTBL_REGISTRY (64 pointers + count, ends at VSOCK_TABLE)
  ;; 0x07FFE000  8KB     VSOCK_TABLE    (64 sockets × 128 bytes, ends 0x08000000)
  ;; 0x00012000  60MB    Guest address space (PE sections + DLLs + large data)
  ;;   For an NE task image_base is 0, so guest 0x00100000 + 8MB is the Win16
  ;;   selector arena (WIN16_ARENA): one 64KB slot per selector index.
  ;;   Slot WIN16_SEG_MAX (guest 0x01FF0000) is past the last usable selector,
  ;;   so no far pointer can name it; it holds the Win16 handle table.
  ;; 0x03C12000  1MB     Former low main stack slot, now free for guest heap
  ;; 0x03D12000  ...     Guest heap grows upward; VirtualAlloc reserves grow downward from thread cache
  ;; 0x03E12000  256KB   Former IAT thunk zone, now free for guest heap
  ;; 0x04A00000   6MB    WIN16_APP_DLL_STAGING (one reusable app-module image)
  ;; allocator-owned 30MB Thread cache (8 slots × 3.75MB decoded-thread arenas)
  ;; 0x07012000  1MB     Main guest stack (ESP starts at top 0x07112000)
  ;; 0x07112000 256KB    IAT thunk zone
  ;; 0x07152000 256KB    Former block-cache index gap (page indexes replaced it)
  ;; 0x07192000  8MB     PE staging area (supports PEs up to 8MB)
  ;; 0x07992000  512B    DLL table (16 DLLs × 32 bytes)
  ;; 0x07992200  128B    DLL resource table (16 DLLs × 8 bytes: rsrc_rva, rsrc_size)
  ;; 0x07992300   64B    DLL path table (16 guest string pointers)
  ;; 0x07992400  ...     File mapping zone (MapViewOfFile allocations)
  ;; 0x08000000 316MB    VirtualAlloc backing; 0x1BC00000 4MB flat guest PTE table
  ;; 0x1C000000  63MB    Page-aligned CreateDIBSection pixel arena
  ;; 0x1FF00000   1MB    THREAD_RPC (per-thread host-import control blocks)
  ;; Total: 8192 pages = 512MB

  ;; Memory region bases. Fixed regions with a companion *_SIZE global are
  ;; checked by test/test-wat-memory-map.js.
  (global $PE_STAGING   i32 (region.addr $PE_STAGING 0))
  (global $PE_STAGING_SIZE i32 (region.size $PE_STAGING))
  (global $GUEST_BASE   i32 (region.addr $GUEST_BASE 0))
  (global $GUEST_BASE_SIZE i32 (region.size $GUEST_BASE))
  (global $GUEST_STACK  i32 (region.addr $GUEST_STACK 0))
  (global $GUEST_STACK_SIZE i32 (region.size $GUEST_STACK))
  (global $GUEST_HEAP_BASE i32 (region.addr $GUEST_HEAP_BASE 0))
  (global $GUEST_HEAP_BASE_SIZE i32 (region.size $GUEST_HEAP_BASE))
  (global $THUNK_BASE   i32 (region.addr $THUNK_BASE 0))
  (global $THUNK_BASE_SIZE i32 (region.size $THUNK_BASE))
  (global $THUNK_END    i32 (i32.const 0x07152000))
  (global $THREAD_CACHE_BASE i32 (region.addr $THREAD_CACHE_BASE 0))
  (global $THREAD_CACHE_BASE_SIZE i32 (region.size $THREAD_CACHE_BASE))
  (global $THREAD_CACHE_STRIDE i32 (i32.const 0x003C0000))
  ;; 0x07152000..0x07192000 held the direct-mapped block-cache index; pages
  ;; replaced it outright (docs/page-compile-design.md §§4/4.1), leaving it free.
  ;; Page compilation (docs/page-compile-design.md). Both regions live in the
  ;; free span 0x04100000..0x05000000 that tools/wat-memory-map.js reports
  ;; between HANDLER_PAIR_HIST_COUNTS and THREAD_CACHE_BASE.
  ;;
  ;; PAGE_INDEX_ARENA: per compiled 4KB guest code page, 4096 u16 entries, one
  ;; per byte of the guest page. An entry is one of three things:
  ;;
  ;;   0x0000..0x3FFF   this byte STARTS a compiled block, at that offset
  ;;                    within the page's threaded-code chunk
  ;;   0x4000..0x7FFF   this byte is COVERED by the block starting at
  ;;                    (entry & 0x3FFF) -- an interior byte, not an entry point
  ;;   0xFFFF           no compiled code covers this byte
  ;;
  ;; The cover half is what makes section 5's per-offset invalidation O(1): a
  ;; write to a code byte reads one entry and learns which block to retire,
  ;; instead of sweeping 4096 hash slots to find out. It costs nothing extra in
  ;; space because a chunk is capped at PAGE_CHUNK_BYTES (0x4000), so a real
  ;; offset never needs bit 14 and the marker is free.
  ;;
  ;; 8KB each, 128 slots per thread, 1MB stride, 8 threads.
  (global $PAGE_INDEX_ARENA i32 (region.addr $PAGE_INDEX_ARENA 0))
  (global $PAGE_INDEX_ARENA_SIZE i32 (region.size $PAGE_INDEX_ARENA))
  (global $PAGE_INDEX_STRIDE i32 (i32.const 0x00100000))
  (global $PAGE_INDEX_BYTES  i32 (i32.const 0x2000))
  (global $PAGE_INDEX_SLOTS  i32 (i32.const 128))
  (global $PAGE_INDEX_NONE   i32 (i32.const 0xFFFF))
  ;; Bit 14 marks an interior byte. "Is this offset an entry point" is therefore
  ;; the single test `entry < PAGE_INDEX_COVER`, which catches 0xFFFF too.
  (global $PAGE_INDEX_COVER  i32 (i32.const 0x4000))
  (global $PAGE_INDEX_OFFMASK i32 (i32.const 0x3FFF))
  ;; PAGE_DIR: per-thread direct-mapped table keyed on the guest page number.
  ;; 1024 entries x 16 bytes: +0 page base (0 = empty), +4 index ptr,
  ;; +8 chunk base, +12 chunk length. 16KB per thread, 8 threads.
  (global $PAGE_DIR_BASE i32 (region.addr $PAGE_DIR_BASE 0))
  (global $PAGE_DIR_BASE_SIZE i32 (region.size $PAGE_DIR_BASE))
  (global $PAGE_DIR_STRIDE i32 (i32.const 0x4000))
  (global $PAGE_DIR_ENTRIES i32 (i32.const 1024))
  (global $PAGE_DIR_MASK i32 (i32.const 1023))
  ;; One contiguous chunk per compiled page, carved from the existing per-thread
  ;; decoded-code arena so the established flush machinery already covers it.
  ;; PAGE_CHUNK_BYTES is the 16KB maximum; pages begin in the smallest
  ;; 4/8/12/16KB class that fits and grow on demand. The per-page byte index uses
  ;; 14-bit offsets, so the maximum remains 16KB. Diablo II measured a 2.4KB mean
  ;; payload with 97% at or below 8KB; reserving the maximum for every page made
  ;; its gameplay working set recycle the entire 4MB arena several times per
  ;; slice. Dropped chunks are recycled when no decoded stream can still name
  ;; them.
  (global $PAGE_CHUNK_BYTES i32 (i32.const 0x4000))
  (global $DLL_TABLE_SIZE i32 (region.size $DLL_TABLE))
  (global $DLL_RSRC_TABLE_SIZE i32 (region.size $DLL_RSRC_TABLE))
  (global $DLL_PATH_TABLE_SIZE i32 (region.size $DLL_PATH_TABLE))
  (global $DLL_FLAGS_TABLE_SIZE i32 (region.size $DLL_FLAGS_TABLE))
  ;; Fixed bases declared in later WAT parts still publish their extents here,
  ;; so the memory-map gate can prove that they neither overlap nor run past
  ;; the memory. The two string-storage roots intentionally own several named
  ;; subfields/data segments; those aliases are audited explicitly by the gate.
  (global $WIN16_BUILTIN_NAMES_SIZE i32 (region.size $WIN16_BUILTIN_NAMES))
  (global $GDI_NEAREST_CACHE_SIZE i32 (region.size $GDI_NEAREST_CACHE))
  (global $CP1252_TO_CP437_SIZE i32 (region.size $CP1252_TO_CP437))
  (global $CP437_TO_CP1252_SIZE i32 (region.size $CP437_TO_CP1252))
  (global $DX_VTBL_REGISTRY_SIZE i32 (region.size $DX_VTBL_REGISTRY))
  (global $GDI_BITMAP_FONT_STATIC i32 (region.addr $GDI_BITMAP_FONT_STATIC 0))
  (global $GDI_BITMAP_FONT_STATIC_SIZE i32 (region.size $GDI_BITMAP_FONT_STATIC))
  (global $TT_FONT_STRING_STORAGE i32 (region.addr $TT_FONT_STRING_STORAGE 0))
  (global $TT_FONT_STRING_STORAGE_SIZE i32 (region.size $TT_FONT_STRING_STORAGE))
  ;; Guest-space thunk bounds (set by PE loader: THUNK_BASE/END - GUEST_BASE + image_base)
  (global $thunk_guest_base (mut i32) (i32.const 0))
  (global $thunk_guest_end  (mut i32) (i32.const 0))
  (global $THREAD_BASE  (mut i32) (region.addr $THREAD_CACHE_BASE 0x00000000))
  ;; THREAD_END = THREAD_BASE + THREAD_CACHE_STRIDE. Per-thread partition limit; overflow
  ;; checks use this so main (tid=0) doesn't trample T1's thread cache region.
  ;; Updated in $init_thread per tid.
  (global $THREAD_END   (mut i32) (region.addr $THREAD_CACHE_BASE 0x003C0000))
  ;; Per-thread page-compilation state. Worker threads are separate WASM
  ;; instances over the same memory, so every one of these is per-instance and
  ;; must be re-armed in $init_thread -- see the per-instance-globals rule that
  ;; already governs THREAD_BASE/THREAD_END above.
  (global $PAGE_DIR   (mut i32) (region.addr $PAGE_DIR_BASE 0x00000000))
  (global $PAGE_INDEX (mut i32) (region.addr $PAGE_INDEX_ARENA 0x00000000))
  ;; Bump allocator over this thread's 128 index slots, plus a free list so a
  ;; self-modifying app that drops and re-pages the same page repeatedly does
  ;; not exhaust the arena. A free slot stores the next free pointer in its
  ;; first four bytes; 0 terminates.
  (global $page_index_next (mut i32) (i32.const 0))
  (global $page_index_free (mut i32) (i32.const 0))
  ;; The page currently executing. Straight-line execution inside one page
  ;; never touches PAGE_DIR; only a page-crossing transfer does.
  (global $cur_page_base  (mut i32) (i32.const 0))
  (global $cur_page_index (mut i32) (i32.const 0))
  (global $cur_page_chunk (mut i32) (i32.const 0))
  ;; Counters for the A/B in docs/page-compile-design.md section 8.
  (global $page_compiles (mut i32) (i32.const 0))
  (global $page_hits     (mut i32) (i32.const 0))
  (global $page_misses   (mut i32) (i32.const 0))
  ;; Block transfers $branch_end resolved without unwinding to $run. This is the
  ;; deterministic form of the whole point of the design -- desk trips not taken
  ;; -- and unlike a wall-clock number it means the same thing on a loaded box.
  (global $page_fast     (mut i32) (i32.const 0))
  ;; Conditional branches whose not-taken side became pure adjacency: the next
  ;; block was compiled immediately after this one, so falling through costs no
  ;; eip store, no lookup and no dispatch decision at all. $page_ft_chains counts
  ;; how many decode runs were extended this way, $page_ft_blocks how many blocks
  ;; those runs swallowed, and $page_ft counts the branches taken at runtime that
  ;; paid nothing. See docs/page-compile-design.md section 2.1.
  (global $page_ft_chains (mut i32) (i32.const 0))
  (global $page_ft_blocks (mut i32) (i32.const 0))
  (global $page_ft        (mut i32) (i32.const 0))
  ;; The complement of $page_ft: branches that fell through to a block which
  ;; exists in the same chunk but not adjacently, so the fall-through paid a
  ;; full eip store, index lookup and dispatch. This is the headroom an
  ;; address-ordered emit or a defragmentation pass would be competing for.
  (global $page_ft_missed (mut i32) (i32.const 0))
  ;; Section 5. $page_retires counts blocks retired one at a time by a write to
  ;; a byte they cover; $page_range_drops counts the times a write was too wide
  ;; to be worth walking and the whole page went instead. The ratio is the
  ;; number the design is claiming: a self-modifying app should retire
  ;; individual blocks and almost never drop a page.
  (global $page_retires     (mut i32) (i32.const 0))
  (global $page_range_drops (mut i32) (i32.const 0))
  ;; Blocks that could not be published into a chunk at all -- the page
  ;; directory or the index arena was exhausted, or the chunk was full. With no
  ;; hash cache behind it, such a block is re-decoded on every entry, so this
  ;; being non-trivial is the signal that PAGE_INDEX_SLOTS is too small.
  (global $page_unpublished (mut i32) (i32.const 0))
  ;; $run's per-call block allowance, hoisted out of a local so that
  ;; $branch_end can spend it too. A fast-path block transfer never reaches the
  ;; top of $run, so without this a single run() call would execute as many
  ;; blocks as the step budget allowed and the host's batch sizing would stop
  ;; meaning anything.
  (global $block_budget (mut i32) (i32.const 0))

  ;; How much of its block budget the last run() call actually spent, and what
  ;; stopped it. The host sizes a batch in blocks, but a batch is free to end
  ;; long before that budget is gone -- a blocking API yields, a WM_TIMER sets
  ;; $yield_flag, EIP goes to zero -- and from the outside a batch that ran 1000
  ;; blocks and one that ran 12 look identical. That difference is the whole
  ;; question behind "why is this region of the run so much slower per batch
  ;; than that one": genuine work per block, or a batch that keeps bailing after
  ;; a handful of blocks and paying the host's per-batch overhead each time.
  ;; Halt reasons: 1 budget exhausted, 2 EIP zero, 3 $yield_flag,
  ;; 4 blocking-wait $yield_reason, 5 a debug facility (watchpoint/breakpoint).
  (global $last_run_blocks (mut i32) (i32.const 0))
  (global $last_run_halt   (mut i32) (i32.const 0))

  ;; Where to pick a block up when its step quantum ran out part-way through.
  ;; $next returns without dispatching once $steps hits zero, leaving $ip on the
  ;; op it declined to run; $run used to answer that by looking $eip up again,
  ;; which restarts the block from its first op. That was invisible while every
  ;; block got a fresh 1000 steps of its own — no block is that long — but
  ;; $branch_end spends one quantum across a whole chain of blocks, so expiry
  ;; lands mid-block routinely, and re-running a block's leading pushes moves ESP
  ;; twice. Non-zero means "resume here"; $run consumes it and clears it.
  (global $resume_ip (mut i32) (i32.const 0))
  (global $API_HASH_TABLE i32 (region.addr $API_HASH_TABLE 0))
  (global $API_HASH_TABLE_SIZE i32 (region.size $API_HASH_TABLE))
  ;; Window/class/parent tables (below GUEST_BASE, above the API hash table).
  ;; All four tables live in the 0x7000..0xC000 region; the old 0x2000..0x4000
  ;; layout is now unused and free for future scratch use.
  ;;
  ;; WND_RECORDS: unified per-window record. Replaces the parallel
  ;; WND_TABLE / PARENT_TABLE / USERDATA_TABLE / STYLE_TABLE arrays.
  ;;   +0   hwnd        (0 = empty slot)
  ;;   +4   wndproc
  ;;   +8   parent
  ;;   +12  userdata    (GWL_USERDATA)
  ;;   +16  style
  ;;   +20  state_ptr   (heap ptr to per-class WndState; 0 if none)
  ;; 256 entries × 24 bytes = 0x1800 (0x7000..0x8800)
  (global $WND_RECORDS   i32 (region.addr $WND_RECORDS 0))
  (global $WND_RECORDS_SIZE i32 (region.size $WND_RECORDS))
  (global $MAX_WINDOWS   i32 (i32.const 256))
  ;; CLASS_NAME_STRINGS: the built-in control class names dialog templates and
  ;; GetClassNameA answer with, plus the DirectAnimation coclass/behaviour
  ;; names $handle_CLSIDFromProgID matches. It was declared 0x80 bytes, which
  ;; covered only as far as "SysLink" -- the block actually runs to the RGB555
  ;; mask triplet at 0x32A0, so more than half of it was outside any region
  ;; and every name past 0x3180 was a raw literal nothing could check.
  (global $CLASS_NAME_STRINGS i32 (region.addr $CLASS_NAME_STRINGS 0))
  (global $CLASS_NAME_STRINGS_SIZE i32 (region.size $CLASS_NAME_STRINGS))
  (global $WND_BG_BRUSH_TABLE i32 (region.addr $WND_BG_BRUSH_TABLE 0))
  (global $WND_BG_BRUSH_TABLE_SIZE i32 (region.size $WND_BG_BRUSH_TABLE))
  ;; WNDCLASS.hCursor, resolved per window at creation exactly like the class
  ;; background brush above. $defwndproc_do_setcursor applies it for HTCLIENT,
  ;; which is what makes a tool palette read as buttons (arrow) while the
  ;; drawing area next to it keeps the app's own tool cursor. Zero means the
  ;; class registered a NULL cursor — Win32's way of saying "the window sets
  ;; its own", so the default handler must leave it alone.
  (global $WND_CLASS_CURSOR_TABLE i32 (region.addr $WND_CLASS_CURSOR_TABLE 0))
  (global $WND_CLASS_CURSOR_TABLE_SIZE i32 (region.size $WND_CLASS_CURSOR_TABLE))
  ;; UPDATE_RECT / UPDATE_FLAGS: WAT-owned Win32 update-region state. We store
  ;; a bounding RECT per hwnd slot; JS is only asked to schedule canvas work.
  (global $UPDATE_RECT    i32 (region.addr $UPDATE_RECT 0))
  (global $UPDATE_RECT_SIZE i32 (region.size $UPDATE_RECT))
  (global $UPDATE_FLAGS   i32 (region.addr $UPDATE_FLAGS 0))
  (global $UPDATE_FLAGS_SIZE i32 (region.size $UPDATE_FLAGS))
  ;; NC_FLAGS: parallel to WND_RECORDS, 4 bytes per slot (bits track
  ;; pending WM_NC* messages that GetMessageA synthesises before WM_PAINT).
  (global $NC_FLAGS      i32 (region.addr $NC_FLAGS 0))
  (global $NC_FLAGS_SIZE i32 (region.size $NC_FLAGS))
  ;; NC_FLAGS_COUNT: running count of slots with any bit set, so the
  ;; per-GetMessageA-call scan can early-out when the table is empty.
  (global $nc_flags_count (mut i32) (i32.const 0))
  ;; Sysbutton press state for non-client area chrome. While the user holds
  ;; LMB on a title-bar button (close/min/max), $nc_pressed_hwnd holds that
  ;; window's hwnd and $nc_pressed_hit holds the HT* code (HTCLOSE=20,
  ;; HTMINBUTTON=8, HTMAXBUTTON=9). $defwndproc_ncpaint draws the matching
  ;; button with EDGE_SUNKEN + 1px glyph offset. Set/cleared from JS via
  ;; nc_set_pressed / nc_clear_pressed.
  (global $nc_pressed_hwnd (mut i32) (i32.const 0))
  (global $nc_pressed_hit  (mut i32) (i32.const 0))
  (global $nc_tracking_hit (mut i32) (i32.const 0))
  ;; Scrollbar press state. While the user holds LMB on a scrollbar part
  ;; (1=top/left arrow, 2=bottom/right arrow, 3=top/left page, 4=bottom/
  ;; right page, 5=thumb), $sb_pressed_hwnd holds the scrollbar control's
  ;; hwnd and $sb_pressed_part holds the part code. Thumb drags keep the
  ;; starting mouse coordinate and scroll position in the anchor globals.
  (global $sb_pressed_hwnd (mut i32) (i32.const 0))
  (global $sb_pressed_part (mut i32) (i32.const 0))
  (global $sb_drag_anchor_coord (mut i32) (i32.const 0))
  (global $sb_drag_anchor_pos (mut i32) (i32.const 0))
  ;; TITLE_TABLE: parallel to WND_RECORDS, 8 bytes per slot = { wa_ptr:i32, len:i32 }
  ;; ptr is a WASM linear address of a heap-allocated ASCII title (no NUL).
  ;; Written by SetWindowTextA; read by $defwndproc_handle_ncpaint.
  (global $TITLE_TABLE   i32 (region.addr $TITLE_TABLE 0))
  (global $TITLE_TABLE_SIZE i32 (region.size $TITLE_TABLE))
  ;; MCI_DEVICE_TABLE: 16 slots. Slot 0 is invalid.
  ;;   +0 host_id returned by host_mci_open
  ;;   +4 reserved
  ;;   +8 reserved
  ;;   +12 reserved
  (global $MCI_DEVICE_TABLE i32 (region.addr $MCI_DEVICE_TABLE 0))
  (global $MCI_DEVICE_TABLE_SIZE i32 (region.size $MCI_DEVICE_TABLE))
  ;; OWNER_TABLE: per-window owner hwnd, separate from WND_RECORDS.parent.
  ;; Parent is only for WS_CHILD geometry/clipping. Owner is for owned
  ;; top-level/modal windows and GetWindow(GW_OWNER).
  (global $OWNER_TABLE i32 (region.addr $OWNER_TABLE 0))
  (global $OWNER_TABLE_SIZE i32 (region.size $OWNER_TABLE))
  ;; WNDCLASS.hIcon per window, the same shape as the class cursor above and
  ;; for the same reason: SetClassWord(GCW_HICON) changes what a window shows
  ;; for itself, and the class record it came from may be re-registered or its
  ;; slot reused before anyone reads it back.
  ;; One entry per *window* slot, not per class — $wnd_slot_reset clears it for
  ;; any slot up to MAX_WINDOWS — so it needs the full 256 x 4 bytes. At
  ;; 0x10F00 that reached 0x11300, over the dialog button captions at 0x11000
  ;; and the WAT system strings after them; shrinking the declared size only
  ;; hid the overlap from anyone reading the header. Moved somewhere with room,
  ;; verified with tools/wat-memory-map.js, which is the only way to see that a
  ;; (data ...) segment in one file and a table in another share an address.
  (global $WND_CLASS_ICON_TABLE i32 (region.addr $WND_CLASS_ICON_TABLE 0))
  (global $WND_CLASS_ICON_TABLE_SIZE i32 (region.size $WND_CLASS_ICON_TABLE))
  ;; WND_OWN_DC_TABLE: the private device context of a CS_OWNDC window, one
  ;; entry per window slot. A class registered with CS_OWNDC gets one DC per
  ;; window and keeps it, which is the whole point of the style: what the app
  ;; selects into that DC is still selected the next time it asks for one.
  ;; SkiFree selects the OEM fixed font into its GetDC once at startup and
  ;; paints its stats labels through a later BeginPaint; with a fresh DC each
  ;; time they came back in the default proportional face.
  ;;   0  the class did not ask for a private DC
  ;;  -1  it did, and nothing has asked for the DC yet
  ;;   n  the DC handle, alive until the window is destroyed
  (global $WND_OWN_DC_TABLE i32 (region.addr $WND_OWN_DC_TABLE 0))
  ;; Owning Win32 thread id for each WND_RECORDS slot.  This is deliberately
  ;; separate from OWNER_TABLE: that table is the GW_OWNER HWND relationship,
  ;; while this one is the execution-affinity relationship used by USER message
  ;; routing.  The owning id is written before WND_RECORDS.hwnd is published and
  ;; cleared after hwnd is unpublished.
  ;; Placed after TIMER_SHARED rather than at 0x079C9C00: main grew a
  ;; WND_HINSTANCE_TABLE onto that address independently, and two 1KB tables
  ;; over the same bytes made every window's owning thread read back as an
  ;; HINSTANCE. Run tools/wat-memory-map.js before moving this.
  (global $WND_THREAD_TABLE i32 (region.addr $WND_THREAD_TABLE 0))
  (global $WND_THREAD_TABLE_SIZE i32 (region.size $WND_THREAD_TABLE))
  ;; Shared per-thread USER queues.  Eight emulated thread ids (1..8), each with
  ;; a 64-entry MSG ring.  Queue metadata and payload live in shared memory;
  ;; $LOCK_WND serializes producers and the single owning consumer.
  ;;
  ;; queue +0: count, +4: head, +8: tail, +0x10: 64 x {hwnd,msg,wParam,lParam}
  ;; Moved off 0x079CA000 on the merge from main: WIN16_BUILTIN_NAMES is a data
  ;; segment at that address, and its 512 bytes of export names landed on top of
  ;; queue 1's count/head/tail words. Enqueue then read a count of "KERN" and
  ;; refused every post, and the reader computed a slot address out of bounds.
  (global $THREAD_MSG_QUEUES i32 (region.addr $THREAD_MSG_QUEUES 0))
  (global $THREAD_MSG_QUEUES_SIZE i32 (region.size $THREAD_MSG_QUEUES))
  (global $THREAD_MSG_QUEUE_STRIDE i32 (i32.const 0x00000410))
  (global $THREAD_MSG_QUEUE_MAX i32 (i32.const 64))
  ;; Timer metadata that must be process-wide rather than per-instance.
  ;; +0 active count, +4 next auto id, +0x10 owner tid for each of 16 slots.
  (global $TIMER_SHARED i32 (region.addr $TIMER_SHARED 0))
  (global $TIMER_SHARED_SIZE i32 (region.size $TIMER_SHARED))
  (global $WND_OWN_DC_TABLE_SIZE i32 (region.size $WND_OWN_DC_TABLE))
  ;; Module instance supplied to CreateWindowEx, one dword per window slot.
  ;; DLL-owned helper windows must retain their DLL HINSTANCE: OLEAUT32 checks
  ;; this through GetWindowLong(GWL_HINSTANCE) before reusing its hidden window.
  ;; -1 means an older/template creation path did not provide an instance, in
  ;; which case GetWindowLong keeps the historical EXE-module fallback.
  (global $WND_HINSTANCE_TABLE i32 (region.addr $WND_HINSTANCE_TABLE 0))
  (global $WND_HINSTANCE_TABLE_SIZE i32 (region.size $WND_HINSTANCE_TABLE))
  ;; Current sibling stacking order, parallel to WND_RECORDS. Higher ranks are
  ;; above lower ranks; a process-global sequence is sufficient because ranks
  ;; are compared only between windows with the same parent.
  (global $WND_Z_ORDER_TABLE i32 (region.addr $WND_Z_ORDER_TABLE 0))
  (global $WND_Z_ORDER_TABLE_SIZE i32 (region.size $WND_Z_ORDER_TABLE))
  (global $wnd_z_next (mut i32) (i32.const 0))
  ;; Open files, indexed by the small handle a 16-bit task sees. DOS numbers
  ;; file handles from zero and a C runtime indexes its own per-handle table
  ;; with them, so a task that gets 0x136 back from OpenFile hands it to
  ;; fstat, which finds it past the end of that table and answers -1 without
  ;; ever asking DOS. Klotski compared the size it got with the size it
  ;; expected and reported its score file unreadable. Entry i holds the
  ;; 32-bit handle that 16-bit handle i names, 0 for a free slot; 0-4 stay
  ;; reserved for the standard handles a DOS program assumes it starts with.
  (global $WIN16_FILE_TABLE i32 (region.addr $WIN16_FILE_TABLE 0))
  (global $WIN16_FILE_TABLE_SIZE i32 (region.size $WIN16_FILE_TABLE))
  (global $WIN16_FILE_MAX i32 (i32.const 256))
  ;; Which class record each window was created from, one byte per window slot
  ;; (0xFF = none), and the cbClsExtra bytes that belong to that class. Class
  ;; extra is shared by every window of the class — that is the whole point of
  ;; it, as against cbWndExtra — so it is keyed by class slot and reached
  ;; through the per-window link. Four bytes per class is what the gap between
  ;; here and RICHEDIT_FORMAT_TABLE holds, and it covers the two words apps
  ;; that use class extra at all actually declare; a class asking for more is
  ;; refused in $class_extra_addr rather than aliased onto its neighbour.
  ;;
  ;; These were briefly at 0x07F0A800, which is GDI_BITMAP_FONT_TABLE — the
  ;; font table's globals live in src/10b-gdi-font.wat, not here, so picking an
  ;; address by reading this file alone landed on top of it and corrupted every
  ;; loaded strike. Check every src/*.wat before taking an address.
  ;; And 0x11300 was no better: that is where the WSOCK32 ordinal-import name
  ;; strings live, so one byte per window slot walked straight through them and
  ;; a program that created 256 windows lost its socket imports. It is now in
  ;; the page below WND_RECORDS, which is emulator-private and holds no data
  ;; segment at all.
  (global $WND_CLASS_SLOT_TABLE i32 (region.addr $WND_CLASS_SLOT_TABLE 0))
  (global $WND_CLASS_SLOT_TABLE_SIZE i32 (region.size $WND_CLASS_SLOT_TABLE))
  ;; 0x11400 was DI_DIK_VK_TABLE (09a8-handlers-directx.wat) — a DirectInput
  ;; game and a class with cbClsExtra were writing the same 256 bytes. Moved
  ;; beside the other per-class tables instead.
  (global $CLASS_EXTRA_TABLE i32 (region.addr $CLASS_EXTRA_TABLE 0))
  (global $CLASS_EXTRA_TABLE_SIZE i32 (region.size $CLASS_EXTRA_TABLE))
  (global $CLASS_EXTRA_STRIDE i32 (i32.const 4))
  ;; EDIT visual-line scratch table. Each entry is { char_start, char_len }.
  ;; Used by WAT EDIT controls so wrapped text, caret, hit-testing and scroll
  ;; all share one layout model instead of mixing DrawText with manual math.
  (global $EDIT_LAYOUT_SCRATCH i32 (region.addr $EDIT_LAYOUT_SCRATCH 0))
  (global $EDIT_LAYOUT_SCRATCH_SIZE i32 (region.size $EDIT_LAYOUT_SCRATCH))
  (global $EDIT_LAYOUT_MAX i32 (i32.const 384))
  ;; WAT-owned HRGN records (255 live slots in a 256 x 32-byte table):
  ;;   +0 state (0 free, 1 simple/empty, 2 canonical complex, 3 legacy mirror)
  ;;   +4 generation, +8..+20 bbox RECT, +24 temporary host mirror handle,
  ;;   +28 canonical band-rectangle count.
  ;; Handles use 0x0050GGSS where GG is generation and SS is slot + 1.
  (global $GDI_REGION_TABLE i32 (region.addr $GDI_REGION_TABLE 0))
  (global $GDI_REGION_TABLE_SIZE i32 (region.size $GDI_REGION_TABLE))
  ;; Current path ownership is separate from the selected clip. A closed path
  ;; owns one canonical HRGN copy until the DC is destroyed or a new path wins.
  (global $GDI_DC_PATH_TABLE i32 (region.addr $GDI_DC_PATH_TABLE 0))
  (global $GDI_DC_PATH_TABLE_SIZE i32 (region.size $GDI_DC_PATH_TABLE))
  (global $GDI_DC_PATH_COUNT i32 (i32.const 256))
  (global $GDI_DC_PATH_STRIDE i32 (i32.const 16))
  ;; Each canonical region owns 208 sorted, disjoint half-open RECTs. Slot 255
  ;; remains reserved and never gets a public handle. Boolean and scanline
  ;; operations use four adjacent alias-safe work buffers.
  (global $GDI_REGION_BANDS i32 (region.addr $GDI_REGION_BANDS 0))
  (global $GDI_REGION_BANDS_SIZE i32 (region.size $GDI_REGION_BANDS))
  (global $GDI_REGION_WORK i32 (region.addr $GDI_REGION_WORK 0))
  (global $GDI_REGION_WORK_SIZE i32 (region.size $GDI_REGION_WORK))
  (global $GDI_REGION_RECT_STRIDE i32 (i32.const 0x00000D00))
  (global $GDI_REGION_MAX_RECTS i32 (i32.const 208))
  ;; WAT-owned explicit DC clip registry. Empty HDC slots are zero. Each live
  ;; entry owns its HRGN and publishes only a derived mirror to the host DC.
  (global $GDI_DC_CLIP_TABLE i32 (region.addr $GDI_DC_CLIP_TABLE 0))
  (global $GDI_DC_CLIP_TABLE_SIZE i32 (region.size $GDI_DC_CLIP_TABLE))
  (global $GDI_DC_CLIP_COUNT i32 (i32.const 256))
  (global $GDI_DC_SAVE_TABLE i32 (region.addr $GDI_DC_SAVE_TABLE 0))
  (global $GDI_DC_SAVE_TABLE_SIZE i32 (region.size $GDI_DC_SAVE_TABLE))
  (global $GDI_DC_SAVE_COUNT i32 (i32.const 256))
  (global $GDI_LINE_DESC i32 (region.addr $GDI_LINE_DESC 0))
  (global $GDI_LINE_DESC_SIZE i32 (region.size $GDI_LINE_DESC))
  ;; Two 80-byte surface descriptors for raster/blit destination and source.
  ;; The surface registry owns resolution; pixel kernels consume this scratch.
  (global $GDI_BLIT_DESC i32 (region.addr $GDI_BLIT_DESC 0))
  (global $GDI_BLIT_DST_DESC i32 (region.addr $GDI_BLIT_DESC 0x00000000))
  (global $GDI_BLIT_SRC_DESC i32 (region.addr $GDI_BLIT_DESC 0x00000050))
  (global $GDI_BLIT_DESC_SIZE i32 (region.size $GDI_BLIT_DESC))
  ;; Bitmap creation handlers are synchronous. They share a parsed metadata
  ;; plan and an ANSI conversion buffer for LoadBitmapW resource names.
  (global $GDI_BITMAP_PLAN i32 (region.addr $GDI_BITMAP_PLAN 0))
  (global $GDI_BITMAP_PLAN_SIZE i32 (region.size $GDI_BITMAP_PLAN))
  (global $GDI_RGB555_MASKS i32 (region.addr $DIB_DEFAULT_RGB555_MASKS 0x00000000))
  (global $GDI_BITMAP_NAME i32 (region.addr $GDI_BITMAP_NAME 0))
  (global $GDI_BITMAP_NAME_SIZE i32 (region.size $GDI_BITMAP_NAME))
  ;; Window-coordinate resolution can run while a painter owns PAINT_SCRATCH.
  ;; Keep host GetWindowRect results in private high memory so surface/text
  ;; binding cannot overwrite the caller's RECT.
  (global $WINDOW_RECT_SCRATCH i32 (region.addr $WINDOW_RECT_SCRATCH 0))
  (global $WINDOW_RECT_SCRATCH_SIZE i32 (region.size $WINDOW_RECT_SCRATCH))
  ;; Pattern-brush sampling is synchronous and uses a private bitmap
  ;; descriptor so it cannot clobber active line/blit descriptors.
  (global $GDI_BRUSH_DESC i32 (region.addr $GDI_BRUSH_DESC 0))
  (global $GDI_BRUSH_DESC_SIZE i32 (region.size $GDI_BRUSH_DESC))
  ;; Synchronous DIB_PAL_COLORS decoding resolves WORD logical-palette
  ;; indexes into this RGBQUAD table before a raster operation starts.
  (global $GDI_PALETTE_RESOLVE i32 (region.addr $GDI_PALETTE_RESOLVE 0))
  (global $GDI_PALETTE_RESOLVE_SIZE i32 (region.size $GDI_PALETTE_RESOLVE))
  ;; Canonical DC state. JavaScript receives a transient text-fallback view;
  ;; presentation surfaces contain pixels only and own no GDI semantics.
  (global $GDI_DC_STATE_TABLE i32 (region.addr $GDI_DC_STATE_TABLE 0))
  (global $GDI_DC_STATE_TABLE_SIZE i32 (region.size $GDI_DC_STATE_TABLE))
  (global $GDI_DC_STATE_COUNT i32 (i32.const 512))
  (global $GDI_DC_STATE_STRIDE i32 (i32.const 96))
  ;; Dynamic WAT-owned pen, brush, bitmap, font, palette, and metafile records.
  ;; Handles and all semantic object fields are allocated here.
  ;; Bumped whenever a handle is entered into the table. Worker threads are
  ;; separate WASM instances that share this memory but not their globals, so a
  ;; per-instance negative lookup cache has to revalidate against this counter.
  (global $GDI_OBJECT_GEN i32 (region.addr $GDI_OBJECT_GEN 0))
  (global $GDI_OBJECT_GEN_SIZE i32 (region.size $GDI_OBJECT_GEN))
  (global $GDI_OBJECT_TABLE i32 (region.addr $GDI_OBJECT_TABLE 0))
  (global $GDI_OBJECT_TABLE_SIZE i32 (region.size $GDI_OBJECT_TABLE))
  (global $GDI_OBJECT_COUNT i32 (i32.const 512))
  (global $GDI_OBJECT_STRIDE i32 (i32.const 48))
  ;; One past the highest surface slot ever allocated. Slots are handed out
  ;; front-first, so every live record is below it and a lookup never has to
  ;; walk the other 250-odd empty ones. It lives in shared memory rather than in
  ;; a global for the same reason GDI_OBJECT_GEN does: worker threads are
  ;; separate WASM instances that share this memory but not their globals, and a
  ;; per-instance high-water mark would read 0 in a worker and hand out slot 0
  ;; on top of a live record.
  (global $GDI_WINDOW_SURFACE_HWM i32 (region.addr $GDI_WINDOW_SURFACE_HWM 0))
  (global $GDI_WINDOW_SURFACE_HWM_SIZE i32 (region.size $GDI_WINDOW_SURFACE_HWM))
  (global $GDI_WINDOW_SURFACE_TABLE i32 (region.addr $GDI_WINDOW_SURFACE_TABLE 0))
  (global $GDI_WINDOW_SURFACE_TABLE_SIZE i32 (region.size $GDI_WINDOW_SURFACE_TABLE))
  (global $GDI_WINDOW_SURFACE_COUNT i32 (i32.const 256))
  (global $GDI_WINDOW_SURFACE_STRIDE i32 (i32.const 32))
  (global $GDI_DC_AUX_TABLE i32 (region.addr $GDI_DC_AUX_TABLE 0))
  (global $GDI_DC_AUX_TABLE_SIZE i32 (region.size $GDI_DC_AUX_TABLE))
  (global $GDI_DC_AUX_COUNT i32 (i32.const 256))
  (global $GDI_DC_AUX_STRIDE i32 (i32.const 32))
  (global $GDI_COLOR_ADJUST_TABLE i32 (region.addr $GDI_COLOR_ADJUST_TABLE 0))
  (global $GDI_COLOR_ADJUST_TABLE_SIZE i32 (region.size $GDI_COLOR_ADJUST_TABLE))
  ;; USER-derived visible regions are independent from app-selected DC clips.
  (global $GDI_DC_SYSTEM_CLIP_TABLE i32 (region.addr $GDI_DC_SYSTEM_CLIP_TABLE 0))
  (global $GDI_DC_SYSTEM_CLIP_TABLE_SIZE i32 (region.size $GDI_DC_SYSTEM_CLIP_TABLE))
  (global $GDI_DC_SYSTEM_CLIP_COUNT i32 (i32.const 256))
  ;; How far each DC-keyed table has ever been filled, so a lookup that misses
  ;; can stop instead of walking all 256 slots. These must be memory, not
  ;; globals: worker threads are separate WASM instances sharing this memory,
  ;; so a slot allocated on one thread has to bound the scan on every other.
  ;;   +0 GDI_DC_CLIP_TABLE  +4 GDI_DC_SYSTEM_CLIP_TABLE  +8 GDI_DC_STATE_TABLE
  ;; Moved off 0x07F0C800 on the real-threads merge: that address is HEAP_SHARED,
  ;; the cross-instance low-heap cursor, which main's branch did not have. The two
  ;; would have overlapped silently — test-wat-memory-map.js is what says so.
  (global $GDI_TABLE_MARKS i32 (region.addr $GDI_TABLE_MARKS 0))
  (global $GDI_TABLE_MARKS_SIZE i32 (region.size $GDI_TABLE_MARKS))
  ;; Which TreeView each TV_TABLE item belongs to, parallel-indexed to it. The
  ;; item records are full at 32 bytes, so the owner has to live beside them.
  (global $TV_OWNER_TABLE i32 (region.addr $TV_OWNER_TABLE 0))
  (global $TV_OWNER_TABLE_SIZE i32 (region.size $TV_OWNER_TABLE))
  ;; High-water mark: one past the highest TV_TABLE slot ever allocated. Every
  ;; scan bounds itself with this rather than with the full slot count, so
  ;; growing the table costs nothing for the app that only ever shows a dozen
  ;; items. It lives in memory and not in a global because a worker thread is a
  ;; separate instance with its own globals but the same linear memory, and
  ;; Winamp's AVS fills its tree from a worker while the main thread paints it.
  (global $TV_SLOT_MARK i32 (region.addr $TV_SLOT_MARK 0))
  (global $TV_SLOT_MARK_SIZE i32 (region.size $TV_SLOT_MARK))
  ;; Item-handle sequence, for the same reason: a handle allocated on a worker
  ;; thread has to be unique against the ones the main thread handed out. Two
  ;; items with the same handle turn a sibling walk into a cycle, and the walk
  ;; that appends a child runs until the process is killed.
  (global $TV_HANDLE_SEQ i32 (region.addr $TV_HANDLE_SEQ 0))
  (global $TV_HANDLE_SEQ_SIZE i32 (region.size $TV_HANDLE_SEQ))
  ;; Per-TreeView view state, 16 records x 16 bytes:
  ;;   +0 hwnd (0 = free)  +4 caret item  +8 first visible row  +12 image list
  (global $TV_VIEW_TABLE i32 (region.addr $TV_VIEW_TABLE 0))
  (global $TV_VIEW_TABLE_SIZE i32 (region.size $TV_VIEW_TABLE))
  (global $TV_VIEW_COUNT i32 (i32.const 16))
  ;; Keep WAT-owned object/DC namespaces distinct and outside stock handles.
  (global $gdi_next_object_handle (mut i32) (i32.const 0x00410001))
  (global $gdi_next_dc_handle (mut i32) (i32.const 0x00310001))
  ;; GDI batching is synchronous in this emulator, but the public limit and
  ;; display gamma ramp remain observable process state.
  (global $gdi_batch_limit (mut i32) (i32.const 310))
  (global $gdi_gamma_ramp_guest (mut i32) (i32.const 0))
  ;; Set while a window's backing surface is being replaced after a resize and
  ;; its chrome is being drawn back onto the new one. The repaint allocates a
  ;; window DC, which comes back through $gdi_window_surface_ensure; this stops
  ;; that from starting a second repaint.
  (global $gdi_surface_resize_repaint (mut i32) (i32.const 0))
  ;; Screen-coordinate popup menus use an ordinary WAT bitmap selected into
  ;; this persistent memory DC. JavaScript only attaches its derived Canvas
  ;; presentation as the compositor overlay; it never rasterizes menu chrome.
  (global $gdi_menu_overlay_dc (mut i32) (i32.const 0))
  (global $gdi_menu_overlay_bitmap (mut i32) (i32.const 0))
  (global $gdi_menu_overlay_width (mut i32) (i32.const 0))
  (global $gdi_menu_overlay_height (mut i32) (i32.const 0))
  ;; GetDC(NULL) selects this persistent WAT bitmap. The renderer composites
  ;; its Canvas presentation as the desktop base layer; Canvas never owns or
  ;; writes back screen-DC pixels.
  (global $gdi_screen_bitmap (mut i32) (i32.const 0))
  (global $gdi_screen_width (mut i32) (i32.const 0))
  (global $gdi_screen_height (mut i32) (i32.const 0))
  ;; Threaded-interpreter profiling tables. Enabled only from profiling tools.
  ;; HANDLER_PAIR_HIST_COUNTS is a dense [prev_handler][cur_handler] matrix.
  ;; HANDLER_HIST_COUNT is the SIDE of that matrix and must stay >= the handler
  ;; table size in 02-thread-table.wat -- $handler_hist_record drops any pair
  ;; involving a handler at or above it, so a stale cap silently hides every
  ;; fused superinstruction from the very table used to pick the next fusion.
  ;; tools/check-handler-count.js enforces this. 512*512*4 = 1MB.
  (global $HANDLER_HIST_COUNTS i32 (region.addr $HANDLER_HIST_COUNTS 0))
  (global $HANDLER_HIST_COUNTS_SIZE i32 (region.size $HANDLER_HIST_COUNTS))
  ;; Decode-time op-start index (see docs/loop-idiom-superops-design.md 6.1).
  ;; $te appends the address of every op header it emits; $decode_block resets
  ;; the counter. Pure scratch -- reused by every block, never read at runtime,
  ;; so it costs no per-block memory. Overflow sets $op_index_poison and the
  ;; block is simply not matched.
  (global $OP_INDEX i32 (region.addr $OP_INDEX 0))
  (global $OP_INDEX_SIZE i32 (region.size $OP_INDEX))
  (global $OP_INDEX_MAX i32 (i32.const 2048))
  (global $op_index_n (mut i32) (i32.const 0))
  (global $op_index_poison (mut i32) (i32.const 0))
  ;; One bit per 4KB guest page below $VIRTUAL_ALLOC_MIN, set when a block is
  ;; decoded out of that page. A store into a marked page invalidates the
  ;; cached blocks there. The two $generated_code_* / $generated_sparse_code_*
  ;; ranges only cover code inside the PE image or in the sparse VirtualAlloc
  ;; reserve; Storm generates its blitters into ordinary HeapAlloc memory,
  ;; which falls in neither. 0x10000000 >> 12 = 65536 pages = 8KB of bitmap.
  (global $CODE_PAGE_BITMAP i32 (region.addr $CODE_PAGE_BITMAP 0))
  (global $CODE_PAGE_BITMAP_SIZE i32 (region.size $CODE_PAGE_BITMAP))
  (global $CODE_PAGE_BITMAP_PAGES i32 (i32.const 65536))
  (global $HANDLER_PAIR_HIST_COUNTS i32 (region.addr $HANDLER_PAIR_HIST_COUNTS 0))
  (global $HANDLER_PAIR_HIST_COUNTS_SIZE i32 (region.size $HANDLER_PAIR_HIST_COUNTS))
  (global $HANDLER_HIST_COUNT i32 (i32.const 512))
  (global $BRANCH_CMP_JCC_HIST i32 (region.addr $BRANCH_CMP_JCC_HIST 0))
  (global $BRANCH_CMP_JCC_HIST_SIZE i32 (region.size $BRANCH_CMP_JCC_HIST))
  (global $BRANCH_TEST_JCC_HIST i32 (region.addr $BRANCH_TEST_JCC_HIST 0))
  (global $BRANCH_TEST_JCC_HIST_SIZE i32 (region.size $BRANCH_TEST_JCC_HIST))
  (global $BRANCH_ALU_M32_RO_JCC_HIST i32 (region.addr $BRANCH_ALU_M32_RO_JCC_HIST 0))
  (global $BRANCH_ALU_M32_RO_JCC_HIST_SIZE i32 (region.size $BRANCH_ALU_M32_RO_JCC_HIST))
  (global $HOT_BLOCK_HIST i32 (region.addr $HOT_BLOCK_HIST 0))
  (global $HOT_BLOCK_HIST_SIZE i32 (region.size $HOT_BLOCK_HIST))
  (global $HOT_BLOCK_HIST_COUNT i32 (i32.const 32768))
  (global $hot_block_hist_collisions (mut i32) (i32.const 0))
  (global $SIB_CONSUMER_HIST i32 (region.addr $SIB_CONSUMER_HIST 0))
  (global $SIB_CONSUMER_HIST_SIZE i32 (region.size $SIB_CONSUMER_HIST))
  (global $SIB_CONSUMER_HIST_COUNT i32 (i32.const 8192))
  (global $sib_consumer_hist_collisions (mut i32) (i32.const 0))
  (global $sib_consumer_hist_total (mut i32) (i32.const 0))
  ;; CLIENT_RECT: parallel to WND_RECORDS, 16 bytes per slot = { l,t,r,b } i32s.
  ;; Window-local coordinates of the client area after WM_NCCALCSIZE.
  (global $CLIENT_RECT   i32 (region.addr $CLIENT_RECT 0))
  (global $CLIENT_RECT_SIZE i32 (region.size $CLIENT_RECT))
  ;; CONTROL_TABLE: per-slot control metadata, parallel-indexed to WND_RECORDS.
  ;; 256 entries × 16 bytes = 0x1000 (0x8800..0x9800)
  (global $CONTROL_TABLE i32 (region.addr $CONTROL_TABLE 0))
  (global $CONTROL_TABLE_SIZE i32 (region.size $CONTROL_TABLE))
  ;; CONTROL_GEOM: parallel x/y/w/h table indexed by window slot.
  ;; Stored as 4 × i16 (parent-relative pixels). Populated by
  ;; $ctrl_create_child; consulted by the renderer to enumerate WAT-managed
  ;; child controls without needing host_create_window for each.
  ;; 256 entries × 8 bytes = 0x800 (0x9800..0xA000)
  (global $CONTROL_GEOM  i32 (region.addr $CONTROL_GEOM 0))
  (global $CONTROL_GEOM_SIZE i32 (region.size $CONTROL_GEOM))
  ;; NATIVE_STATUS_BITS: windows whose registered common-control wndproc owns
  ;; layout/messages while WAT paints their shared-surface status-bar pixels.
  ;; Keep this separate from CONTROL_TABLE: a non-zero control class changes
  ;; SetWindowText/DefWindowProc routing and prevents MFC's status bar sizing.
  (global $NATIVE_STATUS_BITS i32 (region.addr $NATIVE_STATUS_BITS 0))
  (global $NATIVE_STATUS_BITS_SIZE i32 (region.size $NATIVE_STATUS_BITS))
  ;; NATIVE_TAB_BITS: registered COMCTL32 tab controls retain their guest
  ;; layout/message proc while WAT replaces only their shared-surface paint.
  (global $NATIVE_TAB_BITS i32 (region.addr $NATIVE_TAB_BITS 0))
  (global $NATIVE_TAB_BITS_SIZE i32 (region.size $NATIVE_TAB_BITS))
  ;; CLASS_RECORDS: merged class table + WNDCLASSA storage
  ;;   +0  name_hash (0 = empty slot)
  ;;   +4  atom (assigned at registration)
  ;;   +8  WNDCLASSA[40]  (lpfnWndProc lives at record+12)
  ;; 64 entries × 48 bytes = 0xC00 (0xA000..0xAC00)
  (global $CLASS_RECORDS i32 (region.addr $CLASS_RECORDS 0))
  (global $CLASS_RECORDS_SIZE i32 (region.size $CLASS_RECORDS))
  (global $MAX_CLASSES   i32 (i32.const 64))
  ;; RECT scratch used by control wndproc WM_PAINT to call WAT DrawText and the
  ;; other rect-taking primitives (they expect a WASM linear address for the
  ;; rect). Below GUEST_BASE so guest cannot reach it via image-relative
  ;; pointers.
  ;;
  ;; This is a ring of 16 rects, not one rect. Painting nests — a control's
  ;; WM_PAINT can send a message that paints another window — and with a single
  ;; shared rect the inner painter overwrote the one its caller was still
  ;; holding. $paint_rect hands out the next slot, and a caller that dispatches
  ;; into other windows while holding rects brackets the call with
  ;; $paint_scratch_mark / $paint_scratch_reset so the inner frame's slots are
  ;; recycled and the outer frame's are not. See $paint_rect in 10-helpers.wat.
  (global $PAINT_SCRATCH  i32 (region.addr $PAINT_SCRATCH 0))
  (global $PAINT_SCRATCH_SLOTS i32 (i32.const 16))
  (global $PAINT_SCRATCH_SIZE i32 (region.size $PAINT_SCRATCH))
  ;; Cursor into the ring. Mutable globals are per-instance while the memory is
  ;; shared, so two threads painting at once can still land on the same slot.
  ;; That is the pre-existing situation (they shared one rect before) and is not
  ;; what this ring is for; it fixes nesting inside one thread.
  (global $paint_scratch_cursor (mut i32) (i32.const 0))
  ;; PROP_TABLE: SetPropA/GetPropA/RemovePropA storage. Linear scan (apps
  ;; that touch Props rarely have more than a handful of live entries).
  ;;   +0  hwnd       (0 = empty slot)
  ;;   +4  name_hash  (atom for <64k names, FNV-1a otherwise — same as $class_name_hash)
  ;;   +8  value
  ;; 256 entries × 12 bytes = 0xC00 (0x07F00400..0x07F01000)
  (global $PROP_TABLE  i32 (region.addr $PROP_TABLE 0))
  (global $PROP_TABLE_SIZE i32 (region.size $PROP_TABLE))
  (global $MAX_PROPS   i32 (i32.const 256))
  ;; MENU_DATA_TABLE — parallel to WND_RECORDS, indexed by window slot.
  ;; Each entry is a guest heap pointer to that window's menu data blob
  ;; (set via $menu_set, read by $menu_paint_bar / $menu_hittest_bar /
  ;; $menu_paint_dropdown / $menu_hittest_dropdown). 0 = no menu.
  ;; Blob layout (heap-resident, owned by WAT):
  ;;   +0       i32  bar_count
  ;;   +4       bar_items[bar_count] × 16 bytes:
  ;;              +0  i32  text_offset (relative to blob base)
  ;;              +4  i32  text_len
  ;;              +8  i32  child_offset (offset to child header, 0 if none)
  ;;              +12 i32  id (0 for popup bar items; command id otherwise)
  ;;   header per child group:
  ;;     +0  i32  child_count
  ;;     +4  child_items[child_count] × 28 bytes:
  ;;              +0  i32 label_offset
  ;;              +4  i32 label_len
  ;;              +8  i32 shortcut_offset
  ;;              +12 i32 shortcut_len
  ;;              +16 i32 flags  (bit0=separator, bit1=grayed, bit2=checked, bit3=popup)
  ;;              +20 i32 id
  ;;              +24 i32 child_offset (nested popup header, 0 if none)
  ;;   string bytes appended at the tail
  (global $MENU_DATA_TABLE i32 (region.addr $MENU_DATA_TABLE 0))
  (global $MENU_DATA_TABLE_SIZE i32 (region.size $MENU_DATA_TABLE))
  ;; WND_DLG_RECORDS — per-window dialog state, parallel to WND_RECORDS slots.
  ;; Populated by $dlg_load when a dialog is created from RT_DIALOG template.
  ;; Consulted by renderer via dlg_* exports.
  ;; 256 entries × 32 bytes = 0x2000 (0xB160..0xD160)
  ;;   +0   dlg_id         resource directory eid that matched ($rsrc_matched_eid)
  ;;                       (0 = unused slot)
  ;;   +4   style          DLGTEMPLATE.style
  ;;   +8   ex_style       DLGTEMPLATE.exStyle
  ;;   +12  x (i16)        DLU
  ;;   +14  y (i16)        DLU
  ;;   +16  cx (i16)       DLU
  ;;   +18  cy (i16)       DLU
  ;;   +20  title_ptr      guest heap ptr to NUL-terminated ASCII title (0 if none)
  ;;   +24  menu_key       template menu field: int id, or guest ptr to ASCII name (0 if none)
  ;;   +28  ctrl_count     number of controls (child hwnds = first_hwnd..first_hwnd+ctrl_count-1)
  (global $WND_DLG_RECORDS i32 (region.addr $WND_DLG_RECORDS 0))
  (global $WND_DLG_RECORDS_SIZE i32 (region.size $WND_DLG_RECORDS))
  ;; USER dialog-manager state, separate from application GWL_USERDATA.
  ;; 256 entries x 16 bytes, indexed by the corresponding WND_RECORDS slot:
  ;;   +0  DLGPROC
  ;;   +4  DWL_MSGRESULT (offset 0)
  ;;   +8  reserved dialog extra bytes (offset 4 aliases DLGPROC)
  ;;   +12 DWL_USER (offset 8)
  (global $DIALOG_STATE_TABLE i32 (region.addr $DIALOG_STATE_TABLE 0))
  (global $DIALOG_STATE_TABLE_SIZE i32 (region.size $DIALOG_STATE_TABLE))
  (global $WINDOW_UNICODE_TABLE i32 (region.addr $WINDOW_UNICODE_TABLE 0))
  (global $WINDOW_UNICODE_TABLE_SIZE i32 (region.size $WINDOW_UNICODE_TABLE))
  ;; Process identity lives in shared linear memory rather than a mutable
  ;; global because each emulated Win32 thread is a separate WASM instance.
  (global $SHARED_PROCESS_ID i32 (region.addr $SHARED_PROCESS_ID 0))
  (global $SHARED_PROCESS_ID_SIZE i32 (region.size $SHARED_PROCESS_ID))
  ;; Per-window cbWndExtra-compatible storage. USER classes in WinHelp use
  ;; independent LONG slots at offsets 0, 4, 8, and 12; aliasing these to
  ;; GWL_USERDATA corrupts toolbar layout state.
  (global $WINDOW_EXTRA_TABLE i32 (region.addr $WINDOW_EXTRA_TABLE 0))
  (global $WINDOW_EXTRA_TABLE_SIZE i32 (region.size $WINDOW_EXTRA_TABLE))
  ;; One-shot override for CreateDialogIndirectParam*: when non-zero,
  ;; $dlg_load reads the DLGTEMPLATE directly from this guest pointer
  ;; instead of resolving an RT_DIALOG resource.
  (global $dlg_indirect_template_ptr (mut i32) (i32.const 0))
  ;; SCROLL_TABLE — per-window scroll bar state, parallel to WND_RECORDS slots.
  ;; 256 entries × 24 bytes = 0x1800 (0xD170..0xE970)
  ;;   +0   h_pos     SB_HORZ position
  ;;   +4   h_min     SB_HORZ range min
  ;;   +8   h_max     SB_HORZ range max
  ;;   +12  v_pos     SB_VERT position
  ;;   +16  v_min     SB_VERT range min
  ;;   +20  v_max     SB_VERT range max
  (global $SCROLL_TABLE i32 (region.addr $SCROLL_TABLE 0))
  (global $SCROLL_TABLE_SIZE i32 (region.size $SCROLL_TABLE))
  ;; SCROLL_AUX_TABLE — extra SCROLLINFO fields that do not fit in the legacy
  ;; low-memory SCROLL_TABLE layout. Per WND_RECORDS slot:
  ;;   +0   h_page    SB_HORZ nPage
  ;;   +4   h_track   SB_HORZ nTrackPos
  ;;   +8   v_page    SB_VERT nPage
  ;;   +12  v_track   SB_VERT nTrackPos
  (global $SCROLL_AUX_TABLE i32 (region.addr $SCROLL_AUX_TABLE 0))
  (global $SCROLL_AUX_TABLE_SIZE i32 (region.size $SCROLL_AUX_TABLE))
  ;; SCROLL_ARROW_TABLE — persistent EnableScrollBar/SBM_ENABLE_ARROWS state.
  ;; Per-window byte: bits 0..1 = horizontal ESB_* mask, bits 2..3 = vertical.
  ;; ESB_ENABLE_BOTH=0, ESB_DISABLE_LTUP=1, ESB_DISABLE_RTDN=2,
  ;; ESB_DISABLE_BOTH=3, so each direction fits directly in two bits.
  (global $SCROLL_ARROW_TABLE i32 (region.addr $SCROLL_ARROW_TABLE 0))
  (global $SCROLL_ARROW_TABLE_SIZE i32 (region.size $SCROLL_ARROW_TABLE))
  ;; VSOCK_TABLE — virtual LAN socket records (docs/virtual-lan-party.md).
  ;; 64 entries × 128 bytes, occupying the last 8KB below the sparse
  ;; VirtualAlloc backing pool. Layout is documented in 09d-winsock.wat.
  (global $VSOCK_TABLE i32 (region.addr $VSOCK_TABLE 0))
  (global $VSOCK_TABLE_SIZE i32 (region.size $VSOCK_TABLE))
  ;; FLASH_TABLE — per-window flash state, parallel to WND_RECORDS slots.
  ;; 256 entries × 1 byte = 0x100 (0xE970..0xEA70)
  ;; Each byte: 0 = normal, 1 = flashing (inverted caption)
  (global $FLASH_TABLE i32 (region.addr $FLASH_TABLE 0))
  (global $FLASH_TABLE_SIZE i32 (region.size $FLASH_TABLE))
  ;; SHOW_STATE_TABLE — per-window show state, parallel to WND_RECORDS slots.
  ;; 256 entries × 1 byte, two independent bits because Windows treats them as
  ;; independent: a maximized window that is then minimized restores to
  ;; maximized, so SC_MINIMIZE must not clear the maximized bit.
  ;;   bit 0 (1) — maximized (WS_MAXIMIZE / IsZoomed)
  ;;   bit 1 (2) — minimized (WS_MINIMIZE / IsIconic)
  ;; Written by ShowWindow and by the WM_SYSCOMMAND handler after
  ;; $host_sys_command commits geometry; read through $wnd_max_get /
  ;; $wnd_min_get, which are the only two functions that know the encoding.
  (global $SHOW_STATE_TABLE i32 (region.addr $SHOW_STATE_TABLE 0))
  (global $SHOW_STATE_TABLE_SIZE i32 (region.size $SHOW_STATE_TABLE))
  ;; WINDOW_REGION_BITS — bitset keyed by WND_RECORDS slot. Regioned/skinned
  ;; windows (Winamp) use their whole shaped surface as the client area, so
  ;; later MoveWindow/SetWindowPos NCCALCSIZE must not restore standard chrome
  ;; offsets.
  (global $WINDOW_REGION_BITS i32 (region.addr $WINDOW_REGION_BITS 0))
  (global $WINDOW_REGION_BITS_SIZE i32 (region.size $WINDOW_REGION_BITS))
  ;; RICHEDIT_FORMAT_TABLE — per-window latest explicit CHARFORMAT.yHeight
  ;; seen through EM_SETCHARFORMAT(CFM_SIZE). This is a narrow compatibility
  ;; cache for the current RichEdit shim; it is not a full per-run format model.
  (global $RICHEDIT_FORMAT_TABLE i32 (region.addr $RICHEDIT_FORMAT_TABLE 0))
  (global $RICHEDIT_FORMAT_TABLE_SIZE i32 (region.size $RICHEDIT_FORMAT_TABLE))
  ;; RICHEDIT_PARA_TABLE — per-window heap pointer to a 188-byte PARAFORMAT2A
  ;; snapshot for explicitly set paragraph fields. 0 = no cached fields.
  (global $RICHEDIT_PARA_TABLE i32 (region.addr $RICHEDIT_PARA_TABLE 0))
  (global $RICHEDIT_PARA_TABLE_SIZE i32 (region.size $RICHEDIT_PARA_TABLE))
  ;; Synchronization object table (SharedArrayBuffer backed)
  ;; Each entry (16 bytes):
  ;;   +0: Current issued handle (worker-side exact slot lookup)
  ;;   +4: Type (1=Event, 2=Semaphore)
  ;;   +8: Event state / semaphore count
  ;;   +12: Event ManualReset / semaphore maximum count
  ;; TreeView items, one 32-byte record each. 32 slots was enough while the
  ;; only trees we ever saw were a Preferences page; Winamp's AVS editor fills
  ;; its own tree on top of that one, and an app that gets NULL back from
  ;; TVM_INSERTITEM does not stop asking -- AVS retries the insert forever, so
  ;; a full table reads as a hang rather than as a truncated tree.
  (global $TV_TABLE i32 (region.addr $TV_TABLE 0))
  (global $TV_TABLE_SIZE i32 (region.size $TV_TABLE))
  (global $TV_SLOT_COUNT i32 (i32.const 512))
  (global $TV_IMAGE_TABLE i32 (region.addr $TV_IMAGE_TABLE 0))
  (global $TV_IMAGE_TABLE_SIZE i32 (region.size $TV_IMAGE_TABLE))
  (global $TAB_NATIVE_STATE_TABLE i32 (region.addr $TAB_NATIVE_STATE_TABLE 0))
  (global $TAB_NATIVE_STATE_TABLE_SIZE i32 (region.size $TAB_NATIVE_STATE_TABLE))
  ;; ICON_TABLE: what an HICON actually stands for. An icon handle has to
  ;; survive the round trip from LoadIcon/LoadImage to DrawIconEx, which may
  ;; happen long afterwards and from a different module, so each entry keeps
  ;; the pair needed to find the pixels again: {hInstance, resource id}.
  ;; 32 entries x 8 bytes. Handles are $ICON_HANDLE_TAG | slot.
  (global $ICON_TABLE i32 (region.addr $ICON_TABLE 0))
  (global $ICON_TABLE_SIZE i32 (region.size $ICON_TABLE))
  (global $MAX_ICONS i32 (i32.const 32))
  (global $ICON_HANDLE_TAG i32 (i32.const 0x00650000))
  ;; CURSOR_TABLE: an icon or cursor BUILT from bitmaps, which ICON_TABLE
  ;; cannot describe — there is no {module, resource} to remember, only the
  ;; ICONINFO the app handed to CreateIconIndirect. Each 24-byte entry is that
  ;; struct plus a flag recording whether the host already holds the composited
  ;; pixels for this handle. Handles are $CURSOR_HANDLE_TAG | (slot + 1), so
  ;; slot 0 still produces the non-zero handle callers test for.
  (global $CURSOR_TABLE i32 (region.addr $CURSOR_TABLE 0))
  (global $CURSOR_TABLE_SIZE i32 (region.size $CURSOR_TABLE))
  (global $CURSOR_TABLE_STRIDE i32 (i32.const 24))
  (global $MAX_CURSORS i32 (i32.const 32))
  (global $CURSOR_HANDLE_TAG i32 (i32.const 0x00CC0000))
  ;; Two private surface descriptors: compositing a cursor reads the mask and
  ;; the colour plane at once, and must not borrow the blit scratch.
  (global $CURSOR_MASK_DESC i32 (region.addr $CURSOR_MASK_DESC 0))
  (global $CURSOR_MASK_DESC_SIZE i32 (region.size $CURSOR_MASK_DESC))
  (global $CURSOR_COLOR_DESC i32 (region.addr $CURSOR_COLOR_DESC 0))
  (global $CURSOR_COLOR_DESC_SIZE i32 (region.size $CURSOR_COLOR_DESC))
  ;; DrawIconEx diFlags: which plane of the icon to write.
  (global $DI_MASK   i32 (i32.const 1))
  (global $DI_IMAGE  i32 (i32.const 2))
  (global $DI_NORMAL i32 (i32.const 3))
  (global $SYNC_TABLE i32 (region.addr $SYNC_TABLE 0))
  (global $SYNC_TABLE_SIZE i32 (region.size $SYNC_TABLE))
  (global $MAX_SYNC_OBJECTS i32 (i32.const 512))
  ;; Packed guest page table. One entry covers each 4KB page in the
  ;; complete 32-bit guest address space. Entries store an aligned WASM backing
  ;; page plus normalized access flags in the otherwise-zero low 12 bits.
  (global $GUEST_PAGE_TABLE i32 (region.addr $GUEST_PAGE_TABLE 0))
  (global $GUEST_PAGE_TABLE_SIZE i32 (region.size $GUEST_PAGE_TABLE))
  ;; Backing pages are 4KB-aligned, leaving the low 12 PTE bits for state.
  ;; Keep PAGE_* verbatim in bits 0..10 so VirtualQuery/Protect need no lossy
  ;; reverse mapping. Bit 11 is private PRESENT; a zero entry is unmapped.
  (global $GUEST_PTE_PROTECT_MASK i32 (i32.const 0x7FF))
  (global $GUEST_PTE_PRESENT i32 (i32.const 0x800))
  ;; Sparse VirtualAlloc mapping table. Guest reserve addresses are high
  ;; virtual addresses; committed chunks are backed here so they do not collide
  ;; with the low HeapAlloc arena.
  (global $VIRTUAL_MAP_STATE i32 (region.addr $VIRTUAL_MAP_STATE 0))
  (global $VIRTUAL_MAP_STATE_SIZE i32 (region.size $VIRTUAL_MAP_STATE))
  (global $VIRTUAL_MAP_TABLE i32 (region.addr $VIRTUAL_MAP_TABLE 0))
  (global $VIRTUAL_MAP_TABLE_SIZE i32 (region.size $VIRTUAL_MAP_TABLE))
  (global $MAX_VIRTUAL_MAPS i32 (i32.const 2048))
  (global $VIRTUAL_BACKING_BASE i32 (region.addr $VIRTUAL_BACKING_BASE 0))
  (global $VIRTUAL_BACKING_BASE_SIZE i32 (region.size $VIRTUAL_BACKING_BASE))
  ;; The sparse VA arena ends exactly where the separate DIB guest arena
  ;; begins. Keeping the former 0x40000000 ceiling left 256MB of valid,
  ;; non-overlapping guest address space unused and exhausted StarCraft's
  ;; reserve/free churn before its first command-panel allocation.
  (global $VIRTUAL_ALLOC_TOP_INIT i32 (i32.const 0x50000000))
  (global $VIRTUAL_ALLOC_MIN i32 (i32.const 0x10000000))
  ;; Process-wide heap state, in memory rather than in globals so every instance
  ;; over the shared memory sees one copy. Padded to its own 64-byte cache line:
  ;; sharing a line with another hot shared cell costs more in inter-core line
  ;; transfers than the loads themselves.
  ;;   +0  next unreserved chunk in the low guest heap window (0 = uninitialized)
  ;;   +4  heap_base — immutable after load, published for worker instances
  (global $HEAP_SHARED i32 (region.addr $HEAP_SHARED 0))
  (global $HEAP_SHARED_SIZE i32 (region.size $HEAP_SHARED))
  ;; Cross-instance locks (docs/design-real-threads.md §3.1b). Every guest
  ;; thread is a separate WASM instance over this one memory, so the tables they
  ;; share need a mutex that lives in memory rather than in a global.
  ;;
  ;;   +0  owner: $current_thread_id of the holder, 0 = free (atomic)
  ;;   +4  recursion depth, written only by the owner
  ;;
  ;; Each lock gets its own 64-byte line. Two locks sharing a line ping-pong it
  ;; between cores on every acquire, which costs more than the atomic does.
  ;;
  ;; TWO RULES, both load-bearing:
  ;;   1. Never hold one across a host import. A worker blocks in Atomics.wait
  ;;      for the main thread to serve an import; if the main thread is spinning
  ;;      for the lock that worker holds, neither ever moves. So these wrap pure
  ;;      table arithmetic — slot allocation — and nothing else.
  ;;   2. Never take two at once, so there is no order to get wrong.
  (global $LOCK_TABLE i32 (region.addr $LOCK_TABLE 0))
  (global $LOCK_TABLE_SIZE i32 (region.size $LOCK_TABLE))
  ;; Every CRITICAL_SECTION the guest has initialised, so that one owned by a
  ;; thread that has ended can be found and released. WASM addresses, not guest
  ;; ones: the release runs from whichever instance notices the exit, and in
  ;; worker mode that instance never loaded the PE — its $image_base is 0 and g2w
  ;; would answer nonsense. 256 is generous; msvcrt uses a dozen and an app a
  ;; handful. Overflow just means that section is not tracked, i.e. today's
  ;; behaviour.
  (global $CS_TABLE i32 (region.addr $CS_TABLE 0))
  (global $CS_TABLE_SIZE i32 (region.size $CS_TABLE))
  (global $CS_TABLE_ENTRIES i32 (i32.const 256))
  (global $LOCK_VIRTUAL_MAP i32 (region.addr $LOCK_TABLE 0x00000000))
  (global $LOCK_DX i32 (region.addr $LOCK_TABLE 0x00000040))
  (global $LOCK_SOCKET i32 (region.addr $LOCK_TABLE 0x00000080))
  ;; The window and class tables. Both are claimed by a scan-then-claim — find
  ;; the first empty slot, then write into it — which two threads can run
  ;; through at the same instant and both pick the same slot. The loser's window
  ;; simply stops existing, and nothing reports it. One lock covers both because
  ;; nothing here takes them together (rule 2), and because a window claim and a
  ;; class claim are each a few hundred instructions of pure table arithmetic.
  (global $LOCK_WND i32 (region.addr $LOCK_TABLE 0x00000180))
  ;; Process-wide cells that cannot be mutable globals because every guest
  ;; thread is a separate WASM instance over this shared memory:
  ;;   +0  class atom counter
  ;;   +4  decoded-code invalidation generation
  ;;   +8  process priority class (0 => NORMAL, 0x20); +12 process error mode
  ;; Two instances each starting a private atom counter at 0xC000 give two
  ;; DIFFERENT classes the SAME atom, and CreateWindowA by atom then builds the
  ;; wrong class's window. Priority has the same cross-instance requirement:
  ;; a worker must observe the class selected by the UI thread.
  ;; In the gap between CS_TABLE and GDI_REGION_TABLE. It went at 0x07F0B400
  ;; first, which the memory map's comments show as free and which
  ;; $TT_SUBST_TABLE in 10c-truetype.wat actually owns — so every class
  ;; registration wrote a counter into the TrueType substitution table, and a
  ;; guest thread trapped in font code. test-wat-memory-map.js is what caught
  ;; it: the comments are documentation, that test is the authority.
  (global $SHARED_COUNTERS i32 (region.addr $SHARED_COUNTERS 0))
  (global $SHARED_COUNTERS_SIZE i32 (region.size $SHARED_COUNTERS))
  (global $CLASS_ATOM_BASE i32 (i32.const 0xC000))
  ;; 256 bytes of scratch that belong to the TEST HARNESS, not to the emulator.
  ;; No WAT reads any of it. The layout is fixed by offset so tests in separate
  ;; processes can share the region without sharing a hole:
  ;;
  ;;   +0x00  bump cell         test-wat-locks.js
  ;;   +0x04  barrier           test-wat-locks.js, test-wat-window-tables.js
  ;;   +0x08  round cell        test-wat-window-tables.js
  ;;   +0x0C  done cell         test-wat-window-tables.js
  ;;   +0x10  barrier           test-wat-user-threading.js
  ;;   +0x20  RECT (16B)        test-wat-gdi-region.js
  ;;   +0x40  POINT[24]         test-wat-gdi-region.js
  ;;
  ;; This exists because every one of those cells used to be a raw address in
  ;; somebody else's space. 0x07F0CA00 is described in two tests as "spare bytes
  ;; past LOCK_TABLE" and is in fact $LOCK_TABLE's unused eighth lock line;
  ;; 0x07F0CE50 is the 16-byte hole past $SHARED_COUNTERS; and the GDI region
  ;; tests marshalled their RECT and POINT array through 0x07E09000/0x07E0A000,
  ;; which is $CONSOLE_TEXT. All three are free by accident, and the region
  ;; allocator is about to stop leaving accidents lying around. Storage a test
  ;; writes to is storage: it gets a name, an extent and a place in the overlap
  ;; sweep like everything else.
  (global $TEST_SCRATCH i32 (region.addr $TEST_SCRATCH 0))
  (global $TEST_SCRATCH_SIZE i32 (region.size $TEST_SCRATCH))
  ;; The COM aux-wrapper bump cursor. It was a mutable global, which means a
  ;; private copy per instance handing out the same aux slot twice — the same
  ;; shape of bug $heap_ptr had. Under $LOCK_DX, so plain loads are fine.
  (global $COM_AUX_NEXT_SHARED i32 (region.addr $LOCK_TABLE 0x000000C0))
  ;; The ephemeral-port cursor, for the same reason. Two instances each starting
  ;; at 49152 hand the same port to two sockets; $vsock_port_taken then rejects
  ;; the second bind, so the symptom is a connect that fails rather than a
  ;; crossed wire — still wrong, and invisible. 0 means "not seeded yet".
  (global $VSOCK_NEXT_PORT_SHARED i32 (region.addr $LOCK_TABLE 0x00000100))
  ;; The next free thunk index, process-wide. $num_thunks is BOTH the count and
  ;; the next free index, and it is a per-instance global — so two instances that
  ;; both call GetProcAddress hand out the same thunk address, and the guest then
  ;; calls a thunk whose api id belongs to a different function. That is a jump
  ;; to nowhere with no bad pointer anywhere in the guest's own code.
  ;; $thunk_reserve allocates from here; $update_thunk_end keeps the two in step.
  (global $THUNK_NEXT_SHARED i32 (region.addr $LOCK_TABLE 0x00000140))
  ;; Where the heap starts when no PE was ever loaded — unit-test harnesses call
  ;; the WAT exports directly and still expect HeapAlloc to work. This was the
  ;; old initial value of the $heap_ptr global.
  (global $HEAP_DEFAULT_BASE i32 (region.addr $GUEST_HEAP_BASE 0x00000000))
  ;; Per-instance arena granularity. MSPaint's entire MFC boot is 215 HeapAllocs,
  ;; so one reservation per megabyte makes the shared cursor effectively cold.
  (global $HEAP_ARENA_CHUNK i32 (i32.const 0x00100000))
  ;; DIB sections use a dedicated guest range and fixed linear-memory backing.
  ;; One occupancy byte per 4KB page is 0=free, 1=allocated. The run table
  ;; stores the allocation length only at each allocation's first page.
  (global $DIB_GUEST_BASE i32 (i32.const 0x50000000))
  ;; 63MB, not 64: the last megabyte of linear memory is THREAD_RPC. The DIB pool
  ;; used to run to the very top of memory, which put lib/guest-rpc.js's control
  ;; block (0x1F000000 at the time) 48MB inside it — a guest that allocated that
  ;; much DIB would have overwritten a worker's RPC slots and stalled it forever.
  ;; Guest capacity and backing size must move together or a high DIB address
  ;; translates past its own backing.
  (global $DIB_GUEST_CAPACITY i32 (i32.const 0x03F00000))
  (global $DIB_BACKING_BASE i32 (region.addr $DIB_BACKING_BASE 0))
  (global $DIB_BACKING_BASE_SIZE i32 (region.size $DIB_BACKING_BASE))
  ;; Host-import RPC control blocks, one per guest thread, at the very top of
  ;; linear memory. Declared here rather than only in JS so
  ;; test/test-wat-memory-map.js proves nothing else claims the range —
  ;; test/test-wat-rpc-region.js pins the JS constants to these numbers.
  (global $THREAD_RPC i32 (region.addr $THREAD_RPC 0))
  (global $THREAD_RPC_SIZE i32 (region.size $THREAD_RPC))
  (global $DIB_PAGE_USED i32 (region.addr $DIB_PAGE_USED 0))
  (global $DIB_PAGE_USED_SIZE i32 (region.size $DIB_PAGE_USED))
  (global $DIB_PAGE_RUNS i32 (region.addr $DIB_PAGE_RUNS 0))
  (global $DIB_PAGE_RUNS_SIZE i32 (region.size $DIB_PAGE_RUNS))
  (global $DIB_PAGE_COUNT i32 (i32.const 16384))

  (global $WNDPROC_CTRL_NATIVE i32 (i32.const 0xFFFF0002))  ;; WAT-native control wndproc
  (global $WNDPROC_CONSOLE_NATIVE i32 (i32.const 0xFFFF0003))  ;; WAT-native console window
  (global $SIB_SENTINEL  i32 (i32.const 0xEADEAD))    ;; sentinel for SIB addressing mode
  (global $WNDPROC_WAT_NATIVE i32 (i32.const 0xFFFF0001))  ;; WAT-native window wndproc
  (global $WNDPROC_BUILTIN    i32 (i32.const 0xFFFE0001))  ;; built-in control default wndproc
  ;; USER DefDlgProc wrapper. Must live inside the 0xFFFF____ WAT-native band:
  ;; every "is this an x86 wndproc?" site tests `< 0xFFFF0000`, so a marker
  ;; below that line gets called as guest code and jumps into the void.
  (global $WNDPROC_DIALOG     i32 (i32.const 0xFFFF0004))  ;; USER DefDlgProc wrapper
  ;; API_HASH_COUNT is now in 01b-api-hashes.generated.wat

  ;; Guest code section bounds (set by PE loader)
  (global $code_start (mut i32) (i32.const 0))
  (global $code_end   (mut i32) (i32.const 0))
  ;; Guest pages outside .text that have been executed and cached. Some apps
  ;; generate code into image data; writes to these pages must invalidate cache.
  (global $generated_code_start (mut i32) (i32.const 0))
  (global $generated_code_end   (mut i32) (i32.const 0))

  ;; Thread cache bump allocator
  (global $thread_alloc (mut i32) (region.addr $THREAD_CACHE_BASE 0x00000000))  ;; = THREAD_BASE

  ;; ============================================================
  ;; CPU STATE
  ;; ============================================================
  (global $eax (mut i32) (i32.const 0))
  (global $ecx (mut i32) (i32.const 0))
  (global $edx (mut i32) (i32.const 0))
  (global $ebx (mut i32) (i32.const 0))
  (global $esp (mut i32) (i32.const 0))
  (global $ebp (mut i32) (i32.const 0))
  (global $esi (mut i32) (i32.const 0))
  (global $edi (mut i32) (i32.const 0))
  (global $eip (mut i32) (i32.const 0))
  (global $dbg_prev_eip (mut i32) (i32.const 0))
  ;; The block before that one — see the run loop in 13-exports.wat. A decoder
  ;; trap reports this, because $dbg_prev_eip already names the block it is
  ;; refusing to decode.
  (global $dbg_prev2_eip (mut i32) (i32.const 0))
  (global $dbg_counter (mut i32) (i32.const -1))
  ;; Shadow call-stack for --trace-callstack: ring buffer of ret_addrs.
  ;; Push on CALL, pop on RET. JS reads via get_cs_depth/get_cs_entry.
  ;; cs_enabled gates the push/pop hot path so non-debug runs pay zero cost.
  (global $CS_RING i32 (region.addr $CS_RING 0))
  (global $CS_RING_SIZE i32 (region.size $CS_RING))
  (global $CS_MASK i32 (i32.const 63))   ;; 64 slots, power-of-two for cheap mask
  (global $cs_depth (mut i32) (i32.const 0))
  (global $cs_enabled (mut i32) (i32.const 0))

  ;; Direction flag for string ops (0=up, 1=down)
  (global $df (mut i32) (i32.const 0))

  ;; Lazy flags
  (global $flag_op   (mut i32) (i32.const 0))  ;; 1=add,2=sub,3=logic,4=inc,5=dec,6=mul
  (global $flag_a    (mut i32) (i32.const 0))
  (global $flag_b    (mut i32) (i32.const 0))
  (global $flag_res  (mut i32) (i32.const 0))
  (global $saved_cf  (mut i32) (i32.const 0))  ;; preserved CF across INC/DEC
  (global $flag_sign_shift (mut i32) (i32.const 31))  ;; sign bit position: 31=32-bit, 15=16-bit, 7=8-bit

  ;; Threaded interpreter
  (global $ip    (mut i32) (i32.const 0))
  (global $steps (mut i32) (i32.const 0))
  (global $handler_hist_enabled (mut i32) (i32.const 0))
  ;; Nonzero when ANY of the run loop's debug facilities is armed: watchpoint,
  ;; breakpoint, --count hit counters, --trace-esp, --trace-eip-range, or the
  ;; handler histogram. All six are off in every normal run, so the loop tests
  ;; this one global instead of six. Maintained by $dbg_recompute, which every
  ;; setter that arms one of them calls.
  (global $dbg_any (mut i32) (i32.const 0))
  ;; Block entries recognized as the MSVC small-block-heap scan loop (see
  ;; $sbh_note_candidate). Per instance on purpose: each thread decodes its own
  ;; blocks, so a worker just re-recognizes the same address for itself.
  (global $sbh_eip_a (mut i32) (i32.const 0))
  (global $sbh_eip_b (mut i32) (i32.const 0))
  (global $handler_hist_last (mut i32) (i32.const -1))
  (global $branch_hist_kind (mut i32) (i32.const 0))
  (global $branch_hist_operand (mut i32) (i32.const 0))
  ;; Disabled-by-default compiled packet prototype. The decoder only emits
  ;; handler 356 for exact AoE block/trace addresses implemented by
  ;; $th_stack_packet.
  (global $stack_packet_enabled (mut i32) (i32.const 0))
  (global $stack_packet_addr (mut i32) (i32.const 0x0049D9D1))
  ;; Which packet handler the address above compiles to (1 or 2). Set from JS
  ;; together with the address, so $decode_block carries no binary's function
  ;; addresses — see set_stack_packet_enabled in 13-exports.wat.
  (global $stack_packet_variant (mut i32) (i32.const 1))
  (global $stack_packet_count_enabled (mut i32) (i32.const 1))
  (global $stack_packet_entries (mut i32) (i32.const 0))
  (global $stack_packet_0049d9d1_entries (mut i32) (i32.const 0))
  (global $stack_packet_0049dd20_entries (mut i32) (i32.const 0))
  (global $stack_packet_0049dd20_empty_inline_entries (mut i32) (i32.const 0))
  (global $stack_packet_0049dd20_to_dd8b_entries (mut i32) (i32.const 0))
  (global $stack_packet_0049dd20_to_ddc7_entries (mut i32) (i32.const 0))
  (global $stack_packet_0049dd20_to_e0ad_entries (mut i32) (i32.const 0))

  ;; PE info
  (global $image_base   (mut i32) (i32.const 0))
  (global $entry_point  (mut i32) (i32.const 0))
  (global $num_thunks   (mut i32) (i32.const 0))

  ;; Heap. $heap_ptr/$heap_end bound this INSTANCE's arena, not the process
  ;; heap: mutable globals are per-instance, and every guest thread is another
  ;; instance over the same shared memory, so a single process-wide cursor kept
  ;; in a global is replicated rather than shared and two threads hand out the
  ;; same block. The process-wide cursor lives in memory at HEAP_SHARED; each
  ;; instance reserves a chunk from it and bump-allocates privately in between,
  ;; which keeps the allocation fast path lock-free (see $heap_low_reserve).
  (global $heap_base (mut i32) (i32.const 0))
  (global $heap_ptr (mut i32) (i32.const 0))   ;; 0 = no arena reserved yet
  (global $heap_end (mut i32) (i32.const 0))   ;; exclusive end of this arena
  (global $heap_sparse_ptr (mut i32) (i32.const 0))
  (global $heap_sparse_end (mut i32) (i32.const 0))
  ;; Guest-space top of the downward-growing sparse VirtualAlloc arena. Kept
  ;; 64KB-aligned to match Win32 allocation granularity for NULL MEM_RESERVE
  ;; calls.
  (global $virtual_alloc_top (mut i32) (i32.const 0))

  (global $free_list (mut i32) (i32.const 0))  ;; WASM-space head of free list (0 = empty)
  (global $fake_cmdline_addr (mut i32) (i32.const 0))
  ;; Process environment block: guest pointer to "NAME=VALUE\0"... "\0", and
  ;; the byte capacity of that allocation. Filled from ENV_DEFAULTS on first
  ;; use. One block serves every spelling — GetEnvironmentStringsA/W hand out
  ;; encoded copies of it, GetEnvironmentVariable reads it, and
  ;; SetEnvironmentVariable edits it in place.
  (global $env_block (mut i32) (i32.const 0))
  (global $env_cap   (mut i32) (i32.const 4096))
  ;; Bytes in LAUNCH_ENV_OVERRIDES excluding its final block NUL. Launchers
  ;; fill this before guest entry; $env_ensure merges it without forcing the
  ;; environment heap allocation to happen early.
  (global $launch_env_len (mut i32) (i32.const 0))
  (global $exe_name_wa (mut i32) (region.addr $STRING_CONSTANTS 0x00000020))   ;; WASM addr of exe name string
  (global $exe_name_len (mut i32) (i32.const 7))      ;; length of exe name
  (global $exe_drive (mut i32) (i32.const 0x43))      ;; drive letter reported for the process image
  ;; MSVCRT static data pointers (allocated on first use from heap)
  (global $msvcrt_fmode_ptr   (mut i32) (i32.const 0))
  (global $msvcrt_commode_ptr (mut i32) (i32.const 0))
  (global $msvcrt_acmdln_ptr  (mut i32) (i32.const 0))
  (global $msvcrt_environ_ptr (mut i32) (i32.const 0))
  (global $msvcrt_iob_ptr     (mut i32) (i32.const 0))
  (global $msvcrt_pctype_ptr  (mut i32) (i32.const 0))
  (global $msvcrt_strerror_ptr (mut i32) (i32.const 0))
  (global $msvcrt_tmpnam_ptr  (mut i32) (i32.const 0))
  (global $msvcrt_wcmdln_ptr (mut i32) (i32.const 0))  ;; wide command line pointer
  ;; Guest-space address of catch-return thunk (set during PE load)
  (global $catch_ret_thunk (mut i32) (i32.const 0))
  (global $delphi_seh_thunk (mut i32) (i32.const 0))
  (global $delphi_seh_rec (mut i32) (i32.const 0))
  (global $delphi_exception_record (mut i32) (i32.const 0))
  ;; Synchronous WM_CREATE: continuation thunk + saved state
  (global $createwnd_ret_thunk (mut i32) (i32.const 0))
  (global $sync_msg_ret_thunk (mut i32) (i32.const 0))
  ;; Non-zero while $wnd_send_message is recursively executing an x86 wndproc.
  ;; Host waits in this scope must not yield away the nested guest call frame.
  (global $sync_msg_depth (mut i32) (i32.const 0))
  (global $cbt_hook_ret_thunk (mut i32) (i32.const 0)) ;; CBT hook → WM_CREATE continuation (CACA0002)
  (global $child_cbt_ret_thunk (mut i32) (i32.const 0)) ;; Child CBT hook → dispatch WM_CREATE (CACA0026)
  (global $child_create_ret_thunk (mut i32) (i32.const 0)) ;; Child WM_CREATE returned → hand hwnd back (CACA0027)
  (global $child_create_nccreate_ret_thunk (mut i32) (i32.const 0)) ;; Child WM_NCCREATE returned → WM_CREATE (CACA002E)
  (global $dialog_cbt_ret_thunk (mut i32) (i32.const 0)) ;; Dialog CBT hook → WM_INITDIALOG/return (CACA0028)
  (global $createwnd_nccreate_ret_thunk (mut i32) (i32.const 0)) ;; WM_NCCREATE returned → dispatch WM_CREATE (CACA0029)
  (global $setfocus_ret_thunk (mut i32) (i32.const 0)) ;; focus-callback return (CACA002A)
  (global $child_cbt_saved_hwnd (mut i32) (i32.const 0))
  (global $child_cbt_saved_ret  (mut i32) (i32.const 0))
  (global $dialog_cbt_saved_hwnd (mut i32) (i32.const 0))
  (global $dialog_cbt_saved_ret  (mut i32) (i32.const 0))
  (global $dialog_cbt_saved_proc (mut i32) (i32.const 0))
  (global $dialog_cbt_saved_lparam (mut i32) (i32.const 0))
  ;; Synchronous activation chain (first ShowWindow): ACTIVATEAPP → ACTIVATE → SETFOCUS → done
  (global $createwnd_activate_thunk (mut i32) (i32.const 0))   ;; CACA0022: WM_ACTIVATE
  (global $createwnd_setfocus_thunk (mut i32) (i32.const 0))   ;; CACA0023: WM_SETFOCUS
  (global $createwnd_move_thunk     (mut i32) (i32.const 0))   ;; CACA0024: WM_MOVE
  (global $createwnd_size_thunk     (mut i32) (i32.const 0))   ;; CACA0031: WM_SIZE
  (global $createwnd_saved_hwnd (mut i32) (i32.const 0))
  (global $createwnd_saved_ret  (mut i32) (i32.const 0))
  (global $show_window_activated (mut i32) (i32.const 0))      ;; first-ShowWindow gate
  ;; Set by CreateWindowExA when main_hwnd is created with WS_VISIBLE; consumed by
  ;; CACA0001 (after WM_CREATE returns) to kick off the implicit-show activation
  ;; chain (WM_ACTIVATEAPP → ACTIVATE → SETFOCUS → SIZE → done) without requiring
  ;; the app to call ShowWindow. RCT and other DDraw fullscreen games rely on this
  ;; — they probe display state immediately after CreateWindowEx and expect WM_SIZE
  ;; to have populated client-rect globals before they look at them.
  (global $createwnd_implicit_show (mut i32) (i32.const 0))
  ;; Active top-level window for this thread's message queue. Each guest
  ;; thread owns a separate WASM instance, so this mutable global is naturally
  ;; per-thread while WND_RECORDS remains process-shared.
  (global $active_hwnd (mut i32) (i32.const 0))
  (global $focus_hwnd (mut i32) (i32.const 0))
  (global $clipboard_format_counter (mut i32) (i32.const 0xBFFF))
  ;; Legacy Win9x RegisterShellHook subscriber. The registered SHELLHOOK
  ;; message is the most recently allocated RegisterWindowMessage ID.
  (global $shell_hook_hwnd (mut i32) (i32.const 0))
  (global $shell_hook_message (mut i32) (i32.const 0))
  ;; Process-local RegisterHotKey chain. Nodes live in the guest heap:
  ;; next, hwnd, id, modifiers, vk, registering thread id (6 dwords).
  ;; Each real guest-thread WASM instance owns the registrations made by that
  ;; thread, matching USER's per-registering-thread WM_HOTKEY delivery.
  (global $hotkey_head (mut i32) (i32.const 0))
  (global $guid_counter (mut i32) (i32.const 0))
  ;; WAVE_OUT_SHARED — the open waveOut device's identity in LINEAR MEMORY, so
  ;; every guest-thread instance sees the same one; the mutable globals below
  ;; are per-instance and a native audio worker's copies are all zero.
  ;; Four dwords, exactly as $handle_waveOutOpen writes them:
  ;;   +0 handle   +4 callback   +8 callback instance   +12 callback type
  ;; It fills the 16-byte hole between WND_DLG_RECORDS and SCROLL_TABLE.
  (global $WAVE_OUT_SHARED i32 (region.addr $WAVE_OUT_SHARED 0))
  (global $WAVE_OUT_SHARED_SIZE i32 (region.size $WAVE_OUT_SHARED))
  ;; waveOut audio state
  (global $wave_out_handle (mut i32) (i32.const 0))
  (global $wave_out_callback (mut i32) (i32.const 0))
  (global $wave_out_cb_instance (mut i32) (i32.const 0))
  (global $wave_out_cb_type (mut i32) (i32.const 0))
  (global $wave_out_volume (mut i32) (i32.const 0xFFFFFFFF))  ;; packed L|R, default max
  ;; MMIO buffered-I/O slots. mmioGetInfo/mmioAdvance hand the app a real
  ;; read buffer it memcpy's out of, so each open HMMIO that asks for one
  ;; needs a stable guest block. Lazily allocated table of $MMIO_BUF_SLOTS
  ;; {hmmio, pchBuffer, cchBuffer, owned} records; owned blocks die on close.
  (global $mmio_buf_table (mut i32) (i32.const 0))
  (global $MMIO_BUF_SLOTS i32 (i32.const 8))
  (global $MMIO_BUF_SIZE i32 (i32.const 8192))
  (global $rgn_counter (mut i32) (i32.const 0))
  ;; _initterm trampoline state
  (global $initterm_ptr (mut i32) (i32.const 0))  ;; current position in fn ptr table
  (global $initterm_end (mut i32) (i32.const 0))  ;; end of fn ptr table
  (global $initterm_ret (mut i32) (i32.const 0))  ;; original caller return address
  (global $initterm_thunk (mut i32) (i32.const 0)) ;; guest addr of initterm-return thunk
  ;; CRT atexit registry. The callback array contains guest function pointers
  ;; and grows on demand; normal exit() drains it in reverse registration
  ;; order through the CACA002C continuation thunk. _exit/ExitProcess bypass it.
  (global $atexit_table (mut i32) (i32.const 0))
  (global $atexit_count (mut i32) (i32.const 0))
  (global $atexit_capacity (mut i32) (i32.const 0))
  (global $atexit_exit_code (mut i32) (i32.const 0))
  (global $atexit_ret_thunk (mut i32) (i32.const 0))
  ;; bsearch trampoline state (CACA000C continuation drives the search)
  (global $bsearch_key     (mut i32) (i32.const 0))  ;; guest ptr to key
  (global $bsearch_base    (mut i32) (i32.const 0))  ;; guest ptr to array base
  (global $bsearch_size    (mut i32) (i32.const 0))  ;; element size in bytes
  (global $bsearch_compar  (mut i32) (i32.const 0))  ;; guest fn ptr (cdecl comparator)
  (global $bsearch_low     (mut i32) (i32.const 0))  ;; inclusive lower bound
  (global $bsearch_high    (mut i32) (i32.const 0))  ;; exclusive upper bound
  (global $bsearch_mid     (mut i32) (i32.const 0))  ;; current probe index
  (global $bsearch_ret     (mut i32) (i32.const 0))  ;; caller return address
  (global $bsearch_thunk   (mut i32) (i32.const 0))  ;; guest addr of CACA000C thunk
  ;; qsort trampoline state. Adjacent comparisons make the continuation small
  ;; and let swaps use sparse-safe guest byte accesses (CACA002D).
  (global $qsort_base      (mut i32) (i32.const 0))
  (global $qsort_count     (mut i32) (i32.const 0))
  (global $qsort_size      (mut i32) (i32.const 0))
  (global $qsort_compar    (mut i32) (i32.const 0))
  (global $qsort_pass      (mut i32) (i32.const 0))
  (global $qsort_index     (mut i32) (i32.const 0))
  (global $qsort_ret       (mut i32) (i32.const 0))
  (global $qsort_thunk     (mut i32) (i32.const 0))
  ;; DLL loader state
  (global $dll_count (mut i32) (i32.const 0))
  (global $DLL_TABLE_CAPACITY i32 (i32.const 16))
  (global $DLL_TABLE i32 (region.addr $DLL_TABLE 0))  ;; 32 bytes x 16 DLLs = 512 bytes
  ;; Parallel to DLL_TABLE: per-DLL resource dir (rsrc_rva, rsrc_size). 8 bytes x 16 = 128B.
  (global $DLL_RSRC_TABLE i32 (region.addr $DLL_RSRC_TABLE 0))
  ;; Full path used to load each module, as a guest string pointer. Keeping it
  ;; parallel avoids changing the long-established 32-byte DLL table ABI.
  (global $DLL_PATH_TABLE i32 (region.addr $DLL_PATH_TABLE 0))
  ;; Parallel per-DLL loader flags: bit 0 = static TLS directory present,
  ;; bit 1 = DLL_THREAD_ATTACH/DETACH notifications disabled.
  (global $DLL_FLAGS_TABLE i32 (region.addr $DLL_FLAGS_TABLE 0))
  ;; Active resource-lookup context. base=0 means "use main EXE ($image_base / $rsrc_rva)".
  ;; When a Load*/FindResource* handler is called with a DLL hInstance, these are pushed
  ;; to that DLL's load_addr + rsrc_rva for the duration of the lookup, then cleared.
  (global $rsrc_ctx_base (mut i32) (i32.const 0))
  (global $rsrc_ctx_rva  (mut i32) (i32.const 0))
  (global $exe_size_of_image (mut i32) (i32.const 0))
  ;; rand() state
  (global $rand_seed (mut i32) (i32.const 12345))
  ;; TLS: simple fixed-size TLS (64 slots), allocated in heap on first use
  (global $tls_slots (mut i32) (i32.const 0))  ;; guest ptr to 64 x i32 = 256 bytes
  ;; TLS indexes belong to the process, not one guest-thread WASM instance.
  ;; Give the atomic cursor its own cache line in shared memory.
  (global $TLS_NEXT_INDEX_SHARED i32 (region.addr $TLS_NEXT_INDEX_SHARED 0))
  (global $TLS_NEXT_INDEX_SHARED_SIZE i32 (region.size $TLS_NEXT_INDEX_SHARED))
  ;; Performance counter (monotonic, incremented per query)
  (global $perf_counter_lo (mut i32) (i32.const 0))
  ;; EFLAGS bits outside the six we model lazily (CF/PF/ZF/SF/DF/OF). popfd
  ;; stores them here and pushfd ORs them back, so a bit the interpreter has no
  ;; opinion about still round-trips. Starts at the usual user-mode value:
  ;; bit 9 IF set, everything else clear.
  (global $eflags_extra (mut i32) (i32.const 0x200))

  ;; Time-stamp counter, in emulated cycles. RDTSC derives it from the guest
  ;; millisecond clock at $TSC_HZ_PER_MS, and this global holds the last value
  ;; handed out so the counter never repeats or goes backwards -- code that
  ;; times a region by subtracting two reads must never see a zero delta.
  (global $tsc_last (mut i64) (i64.const 0))
  ;; FS segment base — points to fake TIB (allocated from heap during PE load)
  (global $fs_base (mut i32) (i32.const 0))
  ;; Win32-visible current thread id. Main thread is 1; worker tid N is N+1.
  (global $current_thread_id (mut i32) (i32.const 1))
  ;; Current segment prefix during decoding (set before decode_modrm)
  (global $d_seg (mut i32) (i32.const 0))
  ;; 0x67 address-size override for the instruction being decoded, so
  ;; $decode_modrm can tell 16-bit ModRM encodings from 32-bit ones.
  (global $d_addr16 (mut i32) (i32.const 0))

  ;; Runtime EA temp for SIB addressing
  (global $ea_temp (mut i32) (i32.const 0))

  ;; Window system state
  (global $wndproc_addr (mut i32) (i32.const 0))    ;; WndProc for main window (guest VA)
  (global $wndproc_addr2 (mut i32) (i32.const 0))   ;; WndProc for child/status window
  (global $last_registered_wndproc (mut i32) (i32.const 0)) ;; most recent RegisterClassA wndproc
  (global $wndclass_bg_brush (mut i32) (i32.const 0)) ;; hbrBackground from first RegisterClass
  (global $wndclass_style (mut i32) (i32.const 0))    ;; class style from first RegisterClass
  ;; (removed: $window_dc_hwnd — hwnd is now encoded in DC handle)
  (global $cbt_hook_proc (mut i32) (i32.const 0))     ;; CBT hook proc address (from SetWindowsHookExA WH_CBT)
  (global $keyboard_hook_proc (mut i32) (i32.const 0)) ;; thread WH_KEYBOARD proc; called as queued key messages are retrieved
  (global $capture_hwnd (mut i32) (i32.const 0))      ;; hwnd that has mouse capture (SetCapture/ReleaseCapture)
  (global $cursor_count (mut i32) (i32.const 0))      ;; ShowCursor display count (>=0 = visible)
  (global $current_cursor (mut i32) (i32.const 0x67F00)) ;; HCURSOR last set by SetCursor (default IDC_ARROW)
  (global $caret_hwnd (mut i32) (i32.const 0))        ;; USER caret owner hwnd
  (global $caret_x (mut i32) (i32.const 0))           ;; USER caret client x
  (global $caret_y (mut i32) (i32.const 0))           ;; USER caret client y
  (global $caret_w (mut i32) (i32.const 1))           ;; USER caret width
  (global $caret_h (mut i32) (i32.const 13))          ;; USER caret height
  (global $caret_visible (mut i32) (i32.const 0))     ;; ShowCaret-visible latch
  (global $caret_blink_time (mut i32) (i32.const 530)) ;; ms; Windows' default

  (global $win_ini_name_ptr i32 (region.addr $STRING_CONSTANTS 0x00000000))   ;; WASM ptr to "win.ini\0" string constant
  (global $main_hwnd    (mut i32) (i32.const 0))    ;; Main window handle
  (global $shell_hwnd   (mut i32) (i32.const 0))    ;; USER32 Set/GetShellWindow process state
  (global $next_hwnd    (mut i32) (i32.const 0x10001)) ;; HWND allocator
  (global $next_hmenu   (mut i32) (i32.const 0x800001)) ;; HMENU allocator — opaque handle, no backing state (AppendMenu is no-op; menu bar rendered from PE resources)
  (global $last_load_menu_id (mut i32) (i32.const 0)) ;; low-word resource id from most recent LoadMenuA/W
  (global $last_load_menu_hinst (mut i32) (i32.const 0)) ;; hInstance paired with $last_load_menu_id
  ;; One-shot: the WNDCLASS.hInstance whose lpszMenuName CreateWindowExA just
  ;; adopted as the new window's menu. The class that owns the menu resource is
  ;; often a DLL (HyperTerminal registers SESSION_WINDOW with menu="MainMenu"
  ;; from hypertrm.dll and never calls LoadMenu at all), so the resource lookup
  ;; has to run against that module rather than the EXE. $menu_load consumes and
  ;; clears it on entry.
  (global $class_menu_hinst (mut i32) (i32.const 0))
  ;; ATOM_LOCAL_TABLE / ATOM_GLOBAL_TABLE: string-keyed atom tables. Win32 keeps
  ;; the process-local (AddAtom) and system-global (GlobalAddAtom) namespaces
  ;; separate, and apps rely on that: the same string added to both yields two
  ;; independent atoms with independent reference counts. Each entry is 8 bytes:
  ;;   +0 name — guest heap pointer to the NUL-terminated ANSI name (0 = free)
  ;;   +4 refs — outstanding Add minus Delete calls (0 = free)
  ;; The atom value for slot i is 0xC000 + i, matching the Win32 range for
  ;; string atoms. Integer atoms (HIWORD(lpString) == 0) never occupy a slot.
  (global $ATOM_LOCAL_TABLE  i32 (i32.const 0x00006200))
  (global $ATOM_GLOBAL_TABLE i32 (i32.const 0x00006600))
  ;; CLIPFORMAT_TABLE: registered clipboard format names, same shape as the atom
  ;; tables but with the id stored rather than derived, so the two namespaces can
  ;; never be confused for each other. RegisterClipboardFormat is an *interning*
  ;; call: the whole point is that two callers naming the same string get the
  ;; same number back, which is how riched20 and its container agree on what
  ;; "Rich Text Format" or "Embed Source" means. We used to hand out a fresh id
  ;; per call, so no two components could ever agree on a registered format.
  ;;   +0 name — guest heap pointer to the NUL-terminated ANSI name (0 = free)
  ;;   +4 id   — the CLIPFORMAT value handed out for it
  (global $CLIPFORMAT_TABLE  i32 (i32.const 0x00006A00))
  (global $CLIPFORMAT_SLOTS  i32 (i32.const 128))
  (global $ATOM_TABLE_SLOTS  i32 (i32.const 128))     ;; per table; 128 × 8 = 1KB each
  (global $ATOM_FIRST        i32 (i32.const 0xC000))  ;; first string-atom value
  (global $pending_wm_create (mut i32) (i32.const 0)) ;; deliver WM_CREATE as next GetMessageA
  (global $pending_wm_size   (mut i32) (i32.const 0)) ;; deliver WM_SIZE after WM_CREATE (lParam=cx|cy<<16)
  (global $movewindow_pending_hwnd (mut i32) (i32.const 0)) ;; non-main hwnd awaiting WM_SIZE from MoveWindow
  (global $movewindow_pending_size (mut i32) (i32.const 0)) ;; packed client cx|cy<<16 for that hwnd
  ;; Posted message queue: up to 64 messages, each = (hwnd, msg, wParam, lParam) = 16 bytes
  ;; Stored at fixed WASM address 0x400..0x800 (well below guest memory).
  ;; Bumped from 8 to 64 so calc.exe's 30-button owner-draw WM_DRAWITEM burst
  ;; (posted from button_wndproc WM_PAINT to the x86 SciCalc parent) doesn't
  ;; overflow during the first render frame.
  (global $post_queue_count (mut i32) (i32.const 0))
  (global $pq_read_off (mut i32) (i32.const 0))      ;; Read offset for post_queue_dequeue
  (global $msg_phase    (mut i32) (i32.const 0))    ;; Message loop phase
  (global $freelib_last_handle (mut i32) (i32.const 0)) ;; Last FreeLibrary'd handle (for loop detection)
  (global $quit_flag    (mut i32) (i32.const 0))    ;; Set by PostQuitMessage
  (global $yield_flag   (mut i32) (i32.const 0))    ;; Set by GetMessageA when no input; cleared by run()
  (global $sleep_yielded (mut i32) (i32.const 0))  ;; Set by Sleep handler; NOT cleared by run() — JS reads+clears
  (global $sleep_timeout (mut i32) (i32.const 0))  ;; Last nonzero Sleep(ms), read by JS scheduler.
  (global $paint_pending (mut i32) (i32.const 0))    ;; Set by InvalidateRect, cleared when WM_PAINT sent
  (global $child_paint_hwnd (mut i32) (i32.const 0)) ;; Child window needing WM_PAINT (0=none)
  ;; Paint flags: 1 byte per WND slot (parallel to WND_RECORDS / NC_FLAGS).
  ;; Win32-style — InvalidateRect just sets a per-window pending bit; there
  ;; is no fixed-size queue to overflow. GetMessageA's child-paint phase
  ;; scans this table for the first set bit. 256 slots = 256 bytes total.
  (global $PAINT_FLAGS i32 (region.addr $PAINT_FLAGS 0))
  (global $PAINT_FLAGS_SIZE i32 (region.size $PAINT_FLAGS))
  (global $pending_child_create (mut i32) (i32.const 0)) ;; Child hwnd needing WM_CREATE (0=none)
  (global $pending_child_size   (mut i32) (i32.const 0)) ;; Child WM_SIZE lParam (cx|cy<<16, 0=none)
  (global $pending_child_size_hwnd (mut i32) (i32.const 0)) ;; Child hwnd for pending WM_SIZE
  ;; Timer table at 0xAC00: 16 entries × 20 bytes each (ends 0xAD40)
  ;; Each entry: [hwnd:4][id:4][interval:4][last_tick:4][callback:4]
  ;; Entry with id=0 is unused. Lives just past CLASS_RECORDS (see memory map).
  (global $TIMER_TABLE  i32 (region.addr $TIMER_TABLE 0))
  (global $TIMER_TABLE_SIZE i32 (region.size $TIMER_TABLE))
  (global $TIMER_MAX    i32 (i32.const 16))
  (global $TIMER_ENTRY_SIZE i32 (i32.const 20))
  (global $timer_count  (mut i32) (i32.const 0))    ;; Number of active timers
  (global $auto_timer_id (mut i32) (i32.const 0x1000))  ;; Auto-generated timer IDs start here
  ;; Multimedia timers (timeSetEvent). A single slot is not enough: one client
  ;; commonly runs a periodic service timer *and* short one-shots at the same
  ;; time. Smacker does exactly that — a 31ms periodic audio-service timer plus
  ;; a one-shot per submitted buffer — and with one slot each one-shot evicted
  ;; the periodic timer, fired once, and left no timer at all, so the audio
  ;; buffers were never released and SmackWait spun forever.
  ;; Slot: +0 id (0 = free), +4 interval, +8 callback, +12 dwUser,
  ;;       +16 last_tick, +20 oneshot. $MM_TIMER_NEXT_ID is the id allocator
  ;;       (0 reads as 1). Process-wide, hence memory not globals.
  ;; Both addresses were raw `(i32.const 0x00010800)` / `0x000108C0`, in no
  ;; region at all. The WATX allocator only knows about declared regions, so it
  ;; had put RICHEDIT_FORMAT_TABLE (256 hwnd slots x 4 bytes) at exactly
  ;; 0x00010800: creating any dialog with controls wrote hwnd-slot zeroes over
  ;; timer slot 0's interval and callback while leaving its id intact. The slot
  ;; then read as "always due, callback NULL", which floods the message pump
  ;; with MM_TIMER (0x7FF0) that DispatchMessage declines for its NULL lParam.
  ;; RollerCoaster Tycoon drives its whole game loop from one 50ms
  ;; timeSetEvent and died on its first CreateDialog for this reason.
  (global $MM_TIMER_MAX   i32 (i32.const 8))
  (global $MM_TIMER_ENTRY i32 (i32.const 24))
  (global $MM_TIMER_TABLE i32 (region.addr $MM_TIMER_TABLE 0))
  (global $MM_TIMER_TABLE_SIZE i32 (region.size $MM_TIMER_TABLE))
  (global $MM_TIMER_NEXT_ID i32 (region.addr $MM_TIMER_NEXT_ID 0))
  (global $MM_TIMER_NEXT_ID_SIZE i32 (region.size $MM_TIMER_NEXT_ID))
  (global $mm_timer_in_cb    (mut i32) (i32.const 0))  ;; re-entrancy guard
  ;; A system timer may interrupt a main thread parked in WaitForSingleObject.
  ;; The callback borrows this WASM context, then restores the parked wait.
  (global $mm_timer_resume_yield (mut i32) (i32.const 0))
  (global $mm_timer_ret_thunk (mut i32) (i32.const 0)) ;; CACA000A return thunk
  (global $font_enum_ret_thunk (mut i32) (i32.const 0)) ;; CACA0011 EnumFontFamilies callback return
  ;; LineDDA callback continuation (CACA0012) and exact integer walk state.
  (global $line_dda_ret_thunk (mut i32) (i32.const 0))
  (global $line_dda_callback (mut i32) (i32.const 0))
  (global $line_dda_data (mut i32) (i32.const 0))
  (global $line_dda_x (mut i32) (i32.const 0))
  (global $line_dda_y (mut i32) (i32.const 0))
  (global $line_dda_end_x (mut i32) (i32.const 0))
  (global $line_dda_end_y (mut i32) (i32.const 0))
  (global $line_dda_dx (mut i32) (i32.const 0))
  (global $line_dda_dy (mut i32) (i32.const 0))
  (global $line_dda_sx (mut i32) (i32.const 0))
  (global $line_dda_sy (mut i32) (i32.const 0))
  (global $line_dda_err (mut i32) (i32.const 0))
  (global $line_dda_ret (mut i32) (i32.const 0))
  ;; Clipboard: heap-allocated text buffer (CF_TEXT semantics). Each copy
  ;; replaces the contents — no append/grow. On WM_COPY/Ctrl+C/WM_CUT the
  ;; current ptr is freed (if cap too small) and a fresh one is allocated
  ;; to fit the selection. $clipboard_ptr is a guest address; 0 = empty.
  ;; $clipboard_len is authoritative (no NUL terminator).
  (global $clipboard_ptr (mut i32) (i32.const 0))
  (global $clipboard_cap (mut i32) (i32.const 0))
  (global $clipboard_len (mut i32) (i32.const 0))
  ;; Registered non-OLE "Rich Text Format" clipboard payload. This is separate
  ;; from embedded-object/OLE transfer; it stores a NUL-terminated RTF byte
  ;; string and uses a stable registered format id for the process.
  (global $clipboard_rtf_format_id (mut i32) (i32.const 0))
  (global $clipboard_rtf_ptr (mut i32) (i32.const 0))
  (global $clipboard_rtf_cap (mut i32) (i32.const 0))
  (global $clipboard_rtf_len (mut i32) (i32.const 0))
  ;; Current OLE clipboard IDataObject. The object owns copied STGMEDIUM data;
  ;; OleSetClipboard swaps this reference and OleGetClipboard AddRefs it.
  (global $clipboard_ole_data_object (mut i32) (i32.const 0))
  ;; Opaque binary USER clipboard slot used first for CF_DIB. Unlike text/RTF,
  ;; its byte length comes from the HGLOBAL allocation rather than a NUL scan.
  (global $clipboard_binary_format (mut i32) (i32.const 0))
  (global $clipboard_binary_ptr (mut i32) (i32.const 0))
  (global $clipboard_binary_len (mut i32) (i32.const 0))
  ;; Basic RichEdit formatting captured by WordPad's WAT menu clipboard bridge.
  ;; Text remains in the CF_TEXT-style globals above; these fixed-size snapshots
  ;; preserve selected CHARFORMAT/PARAFORMAT fields for same-session paste.
  (global $clipboard_richedit_cf_ptr (mut i32) (i32.const 0))
  (global $clipboard_richedit_pf_ptr (mut i32) (i32.const 0))
  (global $clipboard_richedit_cf_valid (mut i32) (i32.const 0))
  (global $clipboard_richedit_pf_valid (mut i32) (i32.const 0))
  ;; Thread yield state (for multi-instance threading)
  ;; Pending input event cache for PM_NOREMOVE support.
  ;; When PeekMessageA is called with PM_NOREMOVE, we fetch from JS but cache here.
  ;; Next PM_REMOVE call consumes the cache instead of fetching again.
  (global $pending_input_packed (mut i32) (i32.const 0))
  (global $pending_input_lparam (mut i32) (i32.const 0))
  (global $pending_input_hwnd   (mut i32) (i32.const 0))
  ;; Win32 MSG bookkeeping for GetMessagePos/GetMessageTime and MSG.pt.
  ;; Stored in screen coordinates, as USER does. Host only provides raw
  ;; hwnd/client lParam input; WAT converts it using the HWND tree geometry.
  (global $last_msg_pos_x (mut i32) (i32.const 0))
  (global $last_msg_pos_y (mut i32) (i32.const 0))
  (global $last_msg_time  (mut i32) (i32.const 0))
  ;; ClipCursor confinement rectangle, in screen coordinates. Real USER clips
  ;; hardware cursor movement; JS reads this and clamps generated mouse input.
  (global $clip_cursor_active (mut i32) (i32.const 0))
  (global $clip_cursor_l (mut i32) (i32.const 0))
  (global $clip_cursor_t (mut i32) (i32.const 0))
  (global $clip_cursor_r (mut i32) (i32.const 0))
  (global $clip_cursor_b (mut i32) (i32.const 0))
  ;; Consecutive fruitless EnterCriticalSection rounds on THIS thread, and how
  ;; many sections were taken from a holder that never released one (see
  ;; $handle_EnterCriticalSection). Per-instance on purpose: the count is about
  ;; this thread's own progress.
  (global $cs_wait_spins (mut i32) (i32.const 0))
  (global $cs_steals (mut i32) (i32.const 0))
  (global $cs_waits (mut i32) (i32.const 0))
  (global $cs_bad_leaves (mut i32) (i32.const 0))
  (global $cs_barges (mut i32) (i32.const 0))
  ;; The section this thread last parked on, and its owner at that moment.
  (global $cs_wait_addr (mut i32) (i32.const 0))
  (global $cs_wait_owner (mut i32) (i32.const 0))
  ;; Where this thread was when EnterCriticalSection parked, and whether it is
  ;; still parked. A park deliberately leaves the stdcall frame on the stack for
  ;; the re-entry to find, so if the guest is ever dispatched somewhere ELSE
  ;; while this is set, those 8 bytes are lost and the caller's own `ret` will
  ;; later pop the section pointer and jump to it. That is the trap at
  ;; winamp.exe+0x4fe9c; these three make it visible at the moment it happens
  ;; rather than thousands of instructions later.
  (global $cs_park_pending (mut i32) (i32.const 0))
  (global $cs_park_esp (mut i32) (i32.const 0))
  (global $cs_park_eip (mut i32) (i32.const 0))
  ;; Parked Enters the guest never came back to, and how far ESP had moved by
  ;; the time it was dispatched elsewhere.
  (global $cs_abandoned (mut i32) (i32.const 0))
  (global $cs_abandoned_eip (mut i32) (i32.const 0))
  (global $cs_resume_esp_delta (mut i32) (i32.const 0))
  ;; The last section this thread released without owning, and who did own it. A
  ;; count says how often the emulator ran an Enter and its Leave on different
  ;; threads; these say WHICH section, which is what points at the guest code.
  (global $cs_bad_leave_addr (mut i32) (i32.const 0))
  (global $cs_bad_leave_owner (mut i32) (i32.const 0))
  ;; Fruitless Enter rounds before a section is taken from its holder by force.
  ;;
  ;; Effectively never, and that default is a measurement rather than a
  ;; preference. Stealing rewrites LockCount/RecursionCount under a thread that
  ;; still believes it owns the section, and guest CRT lock code reads those
  ;; fields: with a 2000-round steal, two of Winamp's worker threads jumped into
  ;; a heap structure (EIP = out_wave's thread parameter + 0xc) and trapped. With
  ;; stealing off, the same run traps zero times — the waiter just parks, which is
  ;; a stuck thread with a climbing $cs_waits instead of memory corruption
  ;; somewhere else. A stuck thread is the more honest failure and by far the
  ;; easier one to debug.
  ;;
  ;; `--cs-steal-after=N` sets it, because the two behaviours distinguish two
  ;; different bugs: what is actually wrong in that Winamp run is that a section
  ;; is orphaned by a thread that exits while owning it.
  (global $cs_steal_after (mut i32) (i32.const 0x3FFFFFFF))
  (global $yield_reason (mut i32) (i32.const 0))  ;; 0=none, 1=waiting, 2=exited, 3=com_load_dll, 4=help_load, 5=load_library, 6=modal_dialog, 7=message_wait, 8=net_wait, 9=cs_wait, 10=cross-thread SendMessage, 11=self-suspend, 12=io_wait (lazy VFS chunk), 13=vblank_wait, 14=clock_spin (parked on the millisecond clock), 15=peek_spin (parked on an empty message queue)
  ;; ---- 60 Hz vertical-blank model (src/09a8-handlers-directx.wat) ----
  ;;
  ;; DirectDraw-era games use the display itself as their clock:
  ;; IDirectDraw::WaitForVerticalBlank is supposed to BLOCK until the beam
  ;; comes back, so a guest that calls it once per frame is paced by the
  ;; monitor and costs nothing while it waits. Returning DD_OK instantly --
  ;; what we used to do -- is not merely imprecise, it changes what the game
  ;; decides to do: DX-Ball times 32 of these calls at startup and needs the
  ;; total to exceed 400 ms before it will use vsync at all (see
  ;; docs/re-notes/dxball.md).
  ;;
  ;; There are two clocks behind this, and they are deliberately NOT unified:
  ;;
  ;;  * In the browser the host drives it. requestAnimationFrame IS the
  ;;    display's vblank as far as a page can see, so host.js bumps
  ;;    $vblank_counter from a rAF callback (divided down to ~60 Hz on a
  ;;    high-refresh display) and $vblank_host_driven latches on the first
  ;;    tick. A park then ends on the real compositor beat -- no beat
  ;;    frequency against a synthetic grid, and no standing rAF chain,
  ;;    because the host only arms one while a guest is actually parked.
  ;;
  ;;  * Headless there is no rAF and no display, so the guest clock is the
  ;;    display: the boundary is the next 1/60 s multiple of $host_get_ticks,
  ;;    and test/run.js advances the batch clock to it (the pausedMs seam in
  ;;    lib/batch-clock.js). Without that advance the wait could never
  ;;    resolve at a small --tick-ms-per-batch.
  ;;
  ;; $vblank_deadline_ms is meaningful in both: host-driven it is only the
  ;; no-rAF escape hatch (a hidden tab gets no callbacks at all).
  (global $vblank_counter (mut i32) (i32.const 0))      ;; bumped by the host's vblank_tick()
  (global $vblank_host_driven (mut i32) (i32.const 0))  ;; latched by the first vblank_tick()
  (global $vblank_wait_active (mut i32) (i32.const 0))  ;; a WaitForVerticalBlank/Flip is parked
  (global $vblank_wait_counter (mut i32) (i32.const 0)) ;; $vblank_counter when it parked
  (global $vblank_deadline_ms (mut i32) (i32.const 0))  ;; guest-ms boundary it parked for
  ;; Off by default. A vsync'd Flip is what real hardware does, but it changes
  ;; the pacing of every Flip-presenting game at once, so it is opt-in
  ;; (test/run.js --flip-vsync) until each of them has been measured.
  (global $dx_flip_vsync (mut i32) (i32.const 0))
  ;; ---- spin parking (see $clock_spin_step in src/09a-handlers.wat) ----
  ;;
  ;; Eight of the twenty-two games in docs/frame-pacing-census.md hold their
  ;; frame rate by busy-waiting on the millisecond clock -- Abe's Oddysee makes
  ;; 1.77 MILLION timeGetTime calls in three guest seconds, Half-Life Uplink
  ;; 208 reads per batch. Four more spin on PeekMessage returning empty. Every
  ;; one of those calls is a full API dispatch that computes "not yet", and in
  ;; the browser that is the whole CPU.
  ;;
  ;; Blocking inside an API call is always behaviour-legal -- real Windows can
  ;; preempt a thread anywhere, and these calls in particular are where a real
  ;; machine spends its scheduling quantum -- so the guest can simply be parked
  ;; there. That needs no loop analysis at all, which is why this is form-blind
  ;; and works on a limiter we have never disassembled.
  ;;
  ;; The whole design rests on the DETECTOR being unable to fire on a healthy
  ;; game, because a false park is a stall. Four conditions must hold K times in
  ;; a row (K = $spin_park_k, 8):
  ;;
  ;;   * the same value came back (clock only) -- a 60 fps game reading
  ;;     delta-time sees a different millisecond every frame and never trips;
  ;;   * no OTHER Win32 call happened in between ($spin_dispatch_seq advanced by
  ;;     exactly one, this call) -- a real frame loop renders between two clock
  ;;     reads, and rendering is API calls;
  ;;   * the same return address, so it is one call site, not a pump;
  ;;   * the same ESP, so it is the same stack depth and not a recursion.
  ;;
  ;; Everything here is per-instance state, which is what makes it per-thread:
  ;; a worker instantiates its own module over the shared memory, so a decode
  ;; thread's spin cannot debounce the main thread's clock reads.
  (global $spin_dispatch_seq (mut i32) (i32.const 0))  ;; bumped once per $win32_dispatch
  (global $spin_park_k (mut i32) (i32.const 8))        ;; 0 disables both detectors
  (global $spin_deadline_ms (mut i32) (i32.const 0))   ;; guest ms a clock park is due at
  (global $clock_spin_count (mut i32) (i32.const 0))
  (global $clock_spin_value (mut i32) (i32.const 0))
  (global $clock_spin_seq (mut i32) (i32.const 0))
  (global $clock_spin_ret (mut i32) (i32.const 0))
  (global $clock_spin_esp (mut i32) (i32.const 0))
  ;; The value a park was already taken for. One park per distinct millisecond,
  ;; ever: if the host hands the guest back with the clock still reading the
  ;; same thing, spinning is the honest answer until it moves. Without this the
  ;; pair could ping-pong forever on a clock that is not advancing.
  (global $clock_spin_parked_value (mut i32) (i32.const 0))
  (global $clock_spin_parked_valid (mut i32) (i32.const 0))
  (global $clock_spin_parks (mut i32) (i32.const 0))   ;; diagnostics: trips taken
  (global $peek_spin_count (mut i32) (i32.const 0))
  (global $peek_spin_seq (mut i32) (i32.const 0))
  (global $peek_spin_ret (mut i32) (i32.const 0))
  (global $peek_spin_esp (mut i32) (i32.const 0))
  (global $peek_spin_parks (mut i32) (i32.const 0))
  ;; Parameters published when SendMessage parks on an HWND owned by another
  ;; guest thread.  They are per-instance because only that sender consumes
  ;; them; the scheduler carries them to the target instance.
  (global $send_target_tid (mut i32) (i32.const 0))
  (global $send_hwnd (mut i32) (i32.const 0))
  (global $send_msg (mut i32) (i32.const 0))
  (global $send_wparam (mut i32) (i32.const 0))
  (global $send_lparam (mut i32) (i32.const 0))
  ;; Sender-side compatibility work which must run on the HWND owner after the
  ;; real WndProc returns: 1=EM_FORMATRANGE result model, 2=EM_GETCHARFORMAT
  ;; output patch. The scheduler carries this with the request.
  (global $send_post_kind (mut i32) (i32.const 0))
  ;; Set/GetProcessShutdownParameters. 0x280 is the Win32 default level.
  ;; WsControl's view of the virtual adapter (src/09d-winsock.wat): subnet mask
  ;; and default gateway, both host byte order.
  (global $wsctl_mask (mut i32) (i32.const 0xFFFFFF00))
  (global $wsctl_gateway (mut i32) (i32.const 0x0A4D0001))
  ;; SetUnhandledExceptionFilter's top-level filter, as a guest address. Zero
  ;; means no filter is installed, which is also the value the first caller
  ;; gets back as "the previous filter" -- CRTs save that return value and put
  ;; it back on the way out, so it has to be a real stored slot rather than a
  ;; constant.
  (global $unhandled_exception_filter (mut i32) (i32.const 0))
  ;; One process-global vectored exception registration. The handler address
  ;; doubles as the opaque removal handle in this bounded single-registration
  ;; model; ordinary SEH and top-level filters retain their existing paths.
  (global $vectored_exception_handler (mut i32) (i32.const 0))
  (global $shutdown_level (mut i32) (i32.const 0x280))
  (global $shutdown_flags (mut i32) (i32.const 0))
  (global $loadlib_name_ptr (mut i32) (i32.const 0)) ;; guest addr of DLL name for yield=5
  (global $message_wait_msg_ptr (mut i32) (i32.const 0))
  (global $wait_handle  (mut i32) (i32.const 0))
  (global $wait_handles_ptr (mut i32) (i32.const 0)) ;; if non-zero, wait_handle is nCount
  (global $wait_all (mut i32) (i32.const 0)) ;; WaitForMultipleObjects bWaitAll
  (global $wait_timeout (mut i32) (i32.const 0xFFFFFFFF))
  (global $wait_stack_bytes (mut i32) (i32.const 12))
  ;; COM yield state — saved when yielding for async DLL fetch
  (global $com_clsid_ptr (mut i32) (i32.const 0))   ;; guest addr of CLSID
  (global $com_iid_ptr   (mut i32) (i32.const 0))   ;; guest addr of IID
  (global $com_ppv_ptr   (mut i32) (i32.const 0))   ;; guest addr of ppv output
  (global $com_unk_outer (mut i32) (i32.const 0))   ;; pUnkOuter
  (global $com_cls_ctx   (mut i32) (i32.const 0))   ;; dwClsContext
  (global $com_dll_name  (mut i32) (i32.const 0))   ;; WASM addr of DLL name string (from registry)
  (global $com_state_unknown (mut i32) (i32.const 0)) ;; CoSetState/CoGetState single-thread placeholder
  ;; Process-local Running Object Table. Entries are retained independently of
  ;; the short-lived IRunningObjectTable interface wrappers returned to callers.
  (global $ole_rot_entries (mut i32) (i32.const 0))
  (global $ole_rot_next_cookie (mut i32) (i32.const 1))
  (global $ole_rot_mutating (mut i32) (i32.const 0))
  (global $last_error   (mut i32) (i32.const 0))    ;; GetLastError value
  ;; Process-visible accelerator repository. 0x60001 is already an opaque
  ;; compatibility icon, so accelerator handles start at the next value.
  (global $ACCEL_TABLES i32 (region.addr $ACCEL_TABLES 0))
  (global $ACCEL_TABLES_SIZE i32 (region.size $ACCEL_TABLES))
  (global $ACCEL_TABLE_COUNT i32 (i32.const 64))
  (global $ACCEL_TABLE_STRIDE i32 (i32.const 16))
  (global $ACCEL_TABLE_HANDLE_BASE i32 (i32.const 0x00600002))
  (global $dlg_hwnd     (mut i32) (i32.const 0))    ;; Dialog window handle (most recent, modal or modeless)
  ;; DialogBoxParamA-only hwnd for the modal message pump in 09b-dispatch.wat.
  ;; Unlike $dlg_hwnd, this is NOT clobbered by nested CreateDialogParamA
  ;; calls — so when a modal survey/registration dialog creates a modeless
  ;; child sub-dialog, hwnd-less input in the pump still routes to the outer
  ;; modal dialog's dlgproc. Cleared when the modal ends (dlg_ended).
  (global $dlg_pump_hwnd (mut i32) (i32.const 0))   ;; Modal pump hwnd (DialogBoxParamA only)
  (global $dlg_result   (mut i32) (i32.const 0))    ;; EndDialog return value
  (global $dlg_ended    (mut i32) (i32.const 0))    ;; Flag: EndDialog was called
  ;; HWND whose EndDialog teardown is currently running. Real USER only marks
  ;; the dialog finished and lets DialogBox destroy it after the DLGPROC
  ;; returns, so calling EndDialog twice is harmless there. We destroy inline,
  ;; and $wnd_destroy_recursive dispatches WM_DESTROY back into the guest --
  ;; whose handler calls EndDialog again (Disk Cleanup's OK button), which
  ;; re-enters the teardown for a window still in the table and recurses until
  ;; the host stack dies. Re-entry for the same HWND records the result and
  ;; returns instead.
  (global $dlg_ending_hwnd (mut i32) (i32.const 0))
  ;; Shared-memory mirror for EndDialog calls made from worker-thread WASM
  ;; instances. Thread globals are private; this lets the main modal pump see
  ;; installer worker completion.
  (global $SHARED_DLG_ENDED  i32 (region.addr $SHARED_DLG_ENDED 0))
  (global $SHARED_DLG_ENDED_SIZE i32 (region.size $SHARED_DLG_ENDED))
  (global $SHARED_DLG_RESULT i32 (region.addr $SHARED_DLG_RESULT 0))
  (global $SHARED_DLG_RESULT_SIZE i32 (region.size $SHARED_DLG_RESULT))
  ;; ...and a mirror of $dlg_pump_hwnd itself, for the same reason. Every
  ;; "is this hwnd the active modal dialog?" test has to answer the same way
  ;; on every instance: a worker's own $dlg_pump_hwnd is 0, so EndDialog from
  ;; an installer's extraction thread used to destroy the dialog tree without
  ;; ever raising SHARED_DLG_ENDED, leaving main's CACA0004 pump spinning on
  ;; a dialog that no longer existed (Winamp's NSIS installer, after the
  ;; "Completed" page).
  (global $SHARED_DLG_PUMP_HWND i32 (region.addr $SHARED_DLG_PUMP_HWND 0))
  (global $SHARED_DLG_PUMP_HWND_SIZE i32 (region.size $SHARED_DLG_PUMP_HWND))
  ;; LAUNCH_ENV_OVERRIDES — host-supplied "NAME=VALUE\0" entries appended to
  ;; the ENV_DEFAULTS template by $env_ensure (10-helpers.wat) and filled by
  ;; the test_launch_env_add export (13-exports.wat). The 240-byte extent is
  ;; the bound that export already enforces before it copies, so the region is
  ;; exactly as large as the code says it is; it runs up to WINDOW_EXTRA_TABLE.
  (global $LAUNCH_ENV_OVERRIDES i32 (region.addr $LAUNCH_ENV_OVERRIDES 0))
  (global $LAUNCH_ENV_OVERRIDES_SIZE i32 (region.size $LAUNCH_ENV_OVERRIDES))
  ;; WAT-built MessageBox/common-dialog state has the same cross-instance
  ;; requirement as DialogBoxParam above. Browser Worker mode renders and
  ;; hit-tests through a main-thread shadow instance, while the API call is
  ;; parked in the guest Worker instance. Completion therefore has to cross
  ;; through linear memory rather than a private WebAssembly global.
  (global $SHARED_MODAL_DLG_HWND i32 (region.addr $SHARED_MODAL_DLG_HWND 0))
  (global $SHARED_MODAL_DLG_HWND_SIZE i32 (region.size $SHARED_MODAL_DLG_HWND))
  (global $SHARED_MODAL_RESULT i32 (region.addr $SHARED_MODAL_RESULT 0))
  (global $SHARED_MODAL_RESULT_SIZE i32 (region.size $SHARED_MODAL_RESULT))
  (global $SHARED_MODAL_DONE i32 (region.addr $SHARED_MODAL_DONE 0))
  (global $SHARED_MODAL_DONE_SIZE i32 (region.size $SHARED_MODAL_DONE))
  (global $dlg_proc     (mut i32) (i32.const 0))    ;; Dialog proc address
  (global $dlg_ret_addr (mut i32) (i32.const 0))    ;; Return address for DialogBoxParamA
  (global $dlg_loop_thunk (mut i32) (i32.const 0))  ;; Thunk addr for dialog message loop
  ;; One-shot modal pump yield after guest dialog/window procs return.
  ;; Real USER's modal loop returns to the scheduler between dispatched
  ;; messages; this keeps NSIS/Richedit-heavy dialogs from monopolizing a
  ;; single browser/test batch.
  (global $dlg_callback_yield_pending (mut i32) (i32.const 0))
  ;; HWND that DialogBoxParamA passed as WM_INITDIALOG wParam. If the dialog
  ;; proc returns TRUE, USER applies focus after init returns, after the app
  ;; has populated controls.
  (global $dlg_init_focus_hwnd (mut i32) (i32.const 0))
  ;; Flag set by continuation-thunk handlers that explicitly (re)direct EIP.
  ;; Read by $run's thunk-zone auto-pop: when a handler leaves EIP equal to
  ;; its own thunk addr (e.g. CACA0004 re-enters the dialog pump), the outer
  ;; code needs to know that was intentional — otherwise it pops [esp] as a
  ;; new EIP, stalling the dialog loop with EIP=0.
  (global $handler_set_eip (mut i32) (i32.const 0))
  (global $current_thunk_eip (mut i32) (i32.const 0))
  ;; The class atom allocator lives in shared memory now — see $SHARED_COUNTERS.
  ;; As a mutable global it was a private copy per instance, so two threads
  ;; registering two different classes both got 0xC001.

  ;; ---- Printer compatibility state ----
  ;; Printer DCs select a WAT-owned 2400x3150 32-bpp printable Letter page.
  ;; Canvas is only a derived page presentation/text fallback. GetDeviceCaps
  ;; exposes 300 DPI and a 0.25-inch non-printable margin; lifecycle state
  ;; rejects invalid document/page nesting.
  (global $printer_hdc       (mut i32) (i32.const 0))
  (global $printer_bitmap    (mut i32) (i32.const 0))
  (global $printer_doc_state (mut i32) (i32.const 0)) ;; 0=idle, 1=document, 2=page
  (global $printer_page_count (mut i32) (i32.const 0))
  (global $common_dialog_kind (mut i32) (i32.const 0)) ;; 1=page setup, 2=print
  (global $common_dialog_struct (mut i32) (i32.const 0))

  ;; ---- Modal dialog (Open/Save/Color/Font/...) state ----
  ;;
  ;; When a WAT-driven modal API handler (e.g. $handle_GetOpenFileNameA)
  ;; opens its dialog, it calls $modal_begin to redirect EIP into the
  ;; CACA0006 modal_loop_thunk and yield to JS. JS pumps DOM input into
  ;; the dialog's WAT children via send_message. The dialog's wndproc
  ;; calls $modal_done_ok / $modal_done_cancel which clears
  ;; $modal_dlg_hwnd. The next interpreter iteration sees the cleared
  ;; flag, restores the saved eax/eip/esp via the CACA0006 case in
  ;; $win32_dispatch, and the guest API call returns normally.
  (global $modal_dlg_hwnd  (mut i32) (i32.const 0))  ;; 0 = no modal, else dialog hwnd
  (global $modal_result    (mut i32) (i32.const 0))  ;; 1 = OK, 0 = Cancel
  (global $modal_ret_addr  (mut i32) (i32.const 0))  ;; saved EIP to return to
  (global $modal_saved_esp (mut i32) (i32.const 0))  ;; saved ESP at API entry
  (global $modal_esp_adjust (mut i32) (i32.const 0)) ;; bytes to add to ESP on return
  ;; WAT dialog input is dispatched while the synchronous API call is parked.
  ;; Preserve the Win32 callee-saved register set across that nested work.
  (global $modal_saved_ebx (mut i32) (i32.const 0))
  (global $modal_saved_esi (mut i32) (i32.const 0))
  (global $modal_saved_edi (mut i32) (i32.const 0))
  (global $modal_saved_ebp (mut i32) (i32.const 0))
  (global $modal_restore_pending (mut i32) (i32.const 0))
  (global $modal_loop_thunk (mut i32) (i32.const 0)) ;; CACA0006 thunk addr
  ;; COMCTL32 PropertySheetA uses the common modal pump but owns a real
  ;; guest DLGPROC page inside a WAT-native wizard frame.
  (global $propsheet_header (mut i32) (i32.const 0))
  (global $propsheet_pages (mut i32) (i32.const 0))
  (global $propsheet_page_count (mut i32) (i32.const 0))
  (global $propsheet_page_index (mut i32) (i32.const 0))
  (global $propsheet_page_hwnd (mut i32) (i32.const 0))
  (global $propsheet_frame_hwnd (mut i32) (i32.const 0))
  (global $propsheet_finish_page (mut i32) (i32.const 0))
  (global $propsheet_finish_nmhdr (mut i32) (i32.const 0))
  (global $ddenum_ret_thunk (mut i32) (i32.const 0)) ;; CACA0007 DDEnumerate callback return
  ;; D3D EnumDevices multi-device iteration state (CACA000B)
  (global $d3d_enum_dev_thunk (mut i32) (i32.const 0))
  (global $d3d_enum_dev_idx   (mut i32) (i32.const 0))
  (global $d3d_enum_dev_cb    (mut i32) (i32.const 0))
  (global $d3d_enum_dev_ctx   (mut i32) (i32.const 0))
  (global $d3d_enum_dev_ret   (mut i32) (i32.const 0))
  (global $d3d_enum_dev_mode  (mut i32) (i32.const 0)) ;; 0=legacy D3D1/2/3, 7=D3D7

  ;; EnumChildWindows iteration state (CACA002B). The callback runs once per
  ;; child and may stop the walk by returning FALSE, so the scan position has
  ;; to survive across the guest call the way the D3D enumerators do.
  ;; $enum_child_depth guards the re-entrant case: a callback that itself calls
  ;; EnumChildWindows would otherwise overwrite the outer walk's position.
  (global $enum_child_thunk  (mut i32) (i32.const 0))
  (global $enum_child_parent (mut i32) (i32.const 0))
  (global $enum_child_slot   (mut i32) (i32.const 0))
  (global $enum_child_cb     (mut i32) (i32.const 0))
  (global $enum_child_lparam (mut i32) (i32.const 0))
  (global $enum_child_ret    (mut i32) (i32.const 0))
  (global $enum_child_depth  (mut i32) (i32.const 0))

  ;; EnumResourceNamesA iteration state (CACA0030). Resource names may be
  ;; integer IDs or UTF-16 strings in the PE directory; the latter are copied
  ;; to a temporary ANSI guest buffer for each ENUMRESNAMEPROC callback.
  (global $enum_rsrc_thunk   (mut i32) (i32.const 0))
  (global $enum_rsrc_module  (mut i32) (i32.const 0))
  (global $enum_rsrc_type    (mut i32) (i32.const 0))
  (global $enum_rsrc_cb      (mut i32) (i32.const 0))
  (global $enum_rsrc_lparam  (mut i32) (i32.const 0))
  (global $enum_rsrc_ret     (mut i32) (i32.const 0))
  (global $enum_rsrc_dir     (mut i32) (i32.const 0))
  (global $enum_rsrc_index   (mut i32) (i32.const 0))
  (global $enum_rsrc_count   (mut i32) (i32.const 0))
  (global $enum_rsrc_namebuf (mut i32) (i32.const 0))
  (global $enum_rsrc_depth   (mut i32) (i32.const 0))

  ;; Open / Save dialog: current directory (guest ptr to NUL-terminated
  ;; string). Owns its own heap allocation; replaced via $opendlg_set_dir
  ;; which frees the old buffer first.
  (global $opendlg_current_dir (mut i32) (i32.const 0))
  (global $opendlg_wide (mut i32) (i32.const 0)) ;; current OPENFILENAME is W

  ;; MSComDlg.CommonDialog drives the same WAT-native file dialog through
  ;; IDispatch instead of GetOpenFileNameA. These hold the automation object
  ;; and the OPENFILENAME synthesized for it, so the chosen name can be
  ;; mirrored back onto the FileName property when the dialog closes.
  (global $cd_dlg_root (mut i32) (i32.const 0))
  (global $cd_dlg_ofn  (mut i32) (i32.const 0))

  ;; STEP 6 — find/replace dialog hwnd tracking. Set when $handle_FindTextA
  ;; calls $create_findreplace_dialog. Test bridge queries these via the
  ;; get_findreplace_dlg / get_findreplace_edit exports.
  (global $findreplace_dlg_hwnd  (mut i32) (i32.const 0))
  (global $findreplace_edit_hwnd (mut i32) (i32.const 0))
  (global $findreplace_replace_hwnd (mut i32) (i32.const 0))
  (global $findreplace_is_replace (mut i32) (i32.const 0))
  ;; The Flags word of the notification we last sent. It is also written into
  ;; the caller's FINDREPLACE, but only while that struct is still alive --
  ;; MFC frees its own before the dialog closes -- so this is the copy that
  ;; always says what the dialog actually asked for.
  (global $findreplace_last_flags (mut i32) (i32.const 0))
  ;; Registered FINDMSGSTRING ("commdlg_FindReplace") message. Unlike a
  ;; process-local increment-only stub, repeated registrations of this system
  ;; string must return the same value so modeless Find notifications reach
  ;; MFC applications that register other messages first.
  (global $findreplace_message (mut i32) (i32.const 0))

  ;; Help system state
  (global $help_hwnd        (mut i32) (i32.const 0))  ;; Help window handle (0 = not open)
  (global $help_topic_wa    (mut i32) (i32.const 0))  ;; WASM ptr to current topic text
  (global $help_topic_len   (mut i32) (i32.const 0))  ;; Length of current topic text
  (global $help_title_wa    (mut i32) (i32.const 0))  ;; WASM ptr to help title string
  (global $help_title_len   (mut i32) (i32.const 0))  ;; Length of help title
  (global $help_topic_count (mut i32) (i32.const 0))  ;; Total topics from HLP
  (global $help_cur_topic   (mut i32) (i32.const 0))  ;; Current topic (0=Contents)
  (global $help_scroll_y    (mut i32) (i32.const 0))  ;; Scroll offset pixels
  (global $help_back_stack  (mut i32) (i32.const 0))  ;; WASM addr of back-stack
  (global $help_back_count  (mut i32) (i32.const 0))  ;; Back stack size

  ;; Watchpoint: break when [watch_addr] changes (0=disabled)
  ;; $watch_size: 1/2/4 bytes (default 4 = dword); 0 also treated as 4
  (global $watch_addr (mut i32) (i32.const 0))
  (global $watch_val  (mut i32) (i32.const 0))
  (global $watch_size (mut i32) (i32.const 4))
  ;; Tick count (incremented by GetTickCount, starts at ~1 second)
  (global $tick_count (mut i32) (i32.const 1000))

  ;; PE resource directory RVA (set during PE load)
  (global $rsrc_rva (mut i32) (i32.const 0))

  ;; Emulated Windows version for GetVersion/GetVersionEx
  ;; GetVersion format: high word = build (bit 31 set=Win9x, clear=NT), low word = minor<<8|major
  ;; Win98 = 0xC0000A04, NT 4.0 = 0x05650004, Win2000 = 0x08930005
  (global $winver (mut i32) (i32.const 0xC0000A04))

  ;; EIP breakpoint: break when $eip == $bp_addr (0=disabled).
  ;; $bp_skip_once is set to 1 when the bp fires, so the next run() call
  ;; (which re-enters with $eip still == $bp_addr) dispatches that block
  ;; instead of halting again without making progress.
  (global $bp_addr (mut i32) (i32.const 0))
  (global $bp_skip_once (mut i32) (i32.const 0))
  (global $bp_first_caller (mut i32) (i32.const 0))

  ;; --fault-null: report a guest access that no mapping covers instead of
  ;; letting $g2w absorb it into NULL_SENTINEL. 0=off (the shipping behaviour,
  ;; and the only one that costs nothing: the check lives in the miss path,
  ;; after every translation attempt has already failed), 1=log and continue,
  ;; 2=log and trap. A real Windows program that dereferences NULL takes an
  ;; access violation; the sentinel makes that read zero and write nowhere,
  ;; which keeps buggy guests alive at the cost of hiding where they went
  ;; wrong. Turn this on when a symptom appears far from its cause.
  (global $fault_unmapped (mut i32) (i32.const 0))

  ;; --trace-esp: when flag=1, the run loop calls $host_log_block(eip, esp)
  ;; at each block boundary whose EIP falls inside [lo, hi]. hi=0 means
  ;; "no upper bound". Used to narrow per-block ESP deltas against the
  ;; statically-expected stack effect. See apps/mcm.md MCM-1.
  (global $trace_esp_flag (mut i32) (i32.const 0))
  (global $trace_esp_lo (mut i32) (i32.const 0))
  (global $trace_esp_hi (mut i32) (i32.const 0))

  ;; --trace-eip-range: when flag=1, the run loop calls $host_log_eip(eip) at each
  ;; block boundary whose EIP falls inside [lo, hi]. hi=0 means "no upper bound".
  (global $trace_eip_flag (mut i32) (i32.const 0))
  (global $trace_eip_lo (mut i32) (i32.const 0))
  (global $trace_eip_hi (mut i32) (i32.const 0))

  ;; 1KB scratch for UTF-16→ANSI conversion in Unicode text handlers (ExtTextOutW,
  ;; TextOutW, etc.). WAT-private so guest writes cannot corrupt it.
  (global $TEXT_SCRATCH i32 (region.addr $TEXT_SCRATCH 0))
  (global $TEXT_SCRATCH_SIZE i32 (region.size $TEXT_SCRATCH))
  ;; Console screen buffer. This used to sit at 0x7000/0x7FA0, which is
  ;; WND_RECORDS — every WriteConsole overwrote the window table, so a console
  ;; app corrupted windows it never touched. Cells are capped by
  ;; $CONSOLE_MAX_CELLS so a SetConsoleScreenBufferSize cannot walk off the end.
  (global $CONSOLE_TEXT i32 (region.addr $CONSOLE_TEXT 0))
  (global $CONSOLE_TEXT_SIZE i32 (region.size $CONSOLE_TEXT))
  (global $CONSOLE_ATTR i32 (region.addr $CONSOLE_ATTR 0))
  (global $CONSOLE_ATTR_SIZE i32 (region.size $CONSOLE_ATTR))
  (global $CONSOLE_MAX_CELLS i32 (i32.const 6144))
  ;; Console input queue. $CONSOLE_ATTR's 6144 cells end at 0x07E0F000, which
  ;; leaves one free page before DIB_PAGE_USED.
  ;;   +0  queued event count
  ;;   +4  read cursor (ring index of the oldest queued event)
  ;;   +8  wake event handle, created on first block
  ;;   +12 console mode + 1 (0 = never set, so the $console_mode default applies)
  ;;   +16 the console window's hwnd, 0 until some thread creates it
  ;;   +32 ring of $CONSOLE_INPUT_MAX × 20 bytes:
  ;;       {+0 event type, +4 char/COORD, +8 virtual key/button state,
  ;;        +12 control-key state, +16 mouse event flags}
  ;; This lives in linear memory rather than in globals because memory is
  ;; shared across thread instances and globals are not: the window that reads
  ;; the keyboard and the thread that calls ReadConsole are usually different
  ;; threads, and a global would give each of them its own empty queue.
  (global $CONSOLE_INPUT i32 (region.addr $CONSOLE_INPUT 0))
  (global $CONSOLE_INPUT_SIZE i32 (region.size $CONSOLE_INPUT))
  ;; 102 × 20B ends at +0x818, within the original +0x820 ring end, leaving the shared
  ;; screen-buffer table at +0x840 untouched.
  (global $CONSOLE_INPUT_MAX i32 (i32.const 102))

  ;; EIP hit counters: passive per-block counter at 16 slots (8 bytes each:
  ;; +0 addr i32, +4 count i32). Run loop checks up to $hit_count_n slots per
  ;; block dispatch. Addresses must be x86 block-entry boundaries.
  ;; It used to sit at 0x11F00, "the last free page below GUEST_BASE" -- but the
  ;; Run-dialog strings in src/09c3-controls.wat are laid down over 0x11F00-0x11FA5,
  ;; so 11 of the 16 slots were overwritten at init and --count silently reported 0
  ;; for addresses that were demonstrably hot. It now lives in the free gap between
  ;; CODE_PAGE_BITMAP (ends 0x07F14000) and OP_INDEX (0x07F30000).
  (global $HIT_COUNT_BASE i32 (region.addr $HIT_COUNT_BASE 0))
  (global $HIT_COUNT_BASE_SIZE i32 (region.size $HIT_COUNT_BASE))
  (global $hit_count_n (mut i32) (i32.const 0))

  (global $clipboard_fmt_counter (mut i32) (i32.const 0))

  ;; ---- Win16 / NE loader state (src/08c-ne-loader.wat) ----
  ;; WIN16_SEG_TABLE has one spare entry at WIN16_SEG_MAX, used as scratch by
  ;; $win16_apply_relocs for the entry-table segment out-parameter. The table
  ;; was moved after WIN16_THUNK_TABLE when its original 8KB slot became too
  ;; small; tools/wat-memory-map.js verifies the 16KB placement.
  ;;
  ;; Every GlobalAlloc costs a whole selector, because a selector is what a
  ;; Win16 global handle *is* — so the ceiling here is an out-of-memory limit,
  ;; not a bookkeeping one. Rattler Race makes 140 global allocations loading
  ;; its form and ran out at 255, and VB reports that as its error 7 with an
  ;; empty message box. Civilization II keeps more than 300 global blocks live
  ;; after loading roughly 180 executable/DLL segments, so the former 510-slot
  ;; arena likewise failed with linear memory left. Slot MAX remains the hidden
  ;; handle/resource page; at guest 0x03CF0000 it ends immediately below
  ;; GUEST_HEAP_BASE after g2w translation.
  (global $WIN16_SEG_TABLE i32 (region.addr $WIN16_SEG_TABLE 0))
  (global $WIN16_SEG_TABLE_SIZE i32 (region.size $WIN16_SEG_TABLE))
  (global $WIN16_SEG_MAX   i32 (i32.const 959))
  ;; One entry per distinct (module, ordinal) the task and its DLLs import.
  ;; 256 was not enough once a DLL as large as VBRUN100 was in the picture, and
  ;; the table has room for 2048 — still only 8KB of thunk segment used out of
  ;; the 64KB that selector owns. It cannot remain beside the segment table:
  ;; 0x079C8000 begins WND_Z_ORDER_TABLE. The first complete 8KB gap is after
  ;; GDI_NEAREST_CACHE instead.
  (global $WIN16_THUNK_TABLE i32 (region.addr $WIN16_THUNK_TABLE 0))
  (global $WIN16_THUNK_TABLE_SIZE i32 (region.size $WIN16_THUNK_TABLE))
  (global $WIN16_THUNK_MAX i32 (i32.const 2048))
  ;; Each selector index owns one 64KB slot. The arena sits above the PE guest
  ;; image start: an NE task sets image_base to 0, so nothing else is mapped
  ;; low. 256 slots need 16MB, which reaches guest 0x01000000 — still far below
  ;; the guest stack. 128 was not enough for a Visual Basic 1 game: VBRUN100
  ;; alone is 107 segments, and Rattler Race, Rodent's Revenge, JigSawed,
  ;; GoFigure and TicTacDrop all stopped while the loader was still placing it.
  (global $WIN16_ARENA     i32 (i32.const 0x00100000))
  (global $WIN16_THUNK_SEL (mut i32) (i32.const 0))
  (global $win16_thunk_index (mut i32) (i32.const 0))
  (global $win16_thunk_count (mut i32) (i32.const 0))
  (global $win16_seg_count (mut i32) (i32.const 0))
  (global $win16_auto_data (mut i32) (i32.const 0))
  (global $win16_entry_cs  (mut i32) (i32.const 0))
  (global $win16_entry_ip  (mut i32) (i32.const 0))
  (global $win16_stack_size (mut i32) (i32.const 0))
  (global $win16_heap_size (mut i32) (i32.const 0))
  (global $is_win16        (mut i32) (i32.const 0))
  ;; Execution state for a 16-bit task (src/05c-seg16-ops.wat). $code16 is what
  ;; the decoder reads: it inverts the meaning of the 0x66/0x67 prefixes and
  ;; routes every effective address through the segmented path. It is set from
  ;; $is_win16 when the task starts, and is a separate global because "this
  ;; image is an NE" and "the instruction stream being decoded is 16-bit" are
  ;; not the same claim once a task can call 32-bit code.
  ;; Segment ids follow the ModRM sreg encoding: 0=ES, 1=CS, 2=SS, 3=DS.
  (global $code16 (mut i32) (i32.const 0))
  ;; Set only while a Win16 API thunk is reusing the shared Win32 BeginPaint
  ;; implementation. $win16_call32_begin has to present a 32-bit frame to that
  ;; handler, so $code16 is not a reliable way for it to recognize Win16 USER
  ;; paint semantics.
  (global $win16_beginpaint_call32 (mut i32) (i32.const 0))
  (global $sreg_es (mut i32) (i32.const 0))
  (global $sreg_cs (mut i32) (i32.const 0))
  (global $sreg_ss (mut i32) (i32.const 0))
  (global $sreg_ds (mut i32) (i32.const 0))
  (global $seg_base_es (mut i32) (i32.const 0))
  (global $seg_base_cs (mut i32) (i32.const 0))
  (global $seg_base_ss (mut i32) (i32.const 0))
  (global $seg_base_ds (mut i32) (i32.const 0))
  ;; The last (module, ordinal) $win16_dispatch saw, so a trap or a test can
  ;; name the API that stopped the task without decoding the log stream.
  (global $win16_last_module (mut i32) (i32.const 0))
  (global $win16_last_ordinal (mut i32) (i32.const 0))
  (global $win16_last_is_name (mut i32) (i32.const 0))
  ;; Next free selector index for $win16_alloc_segment, and the task's PSP.
  (global $win16_next_seg (mut i32) (i32.const 0))
  (global $win16_psp_sel (mut i32) (i32.const 0))
  ;; Selector index holding the task's DOS environment block, filled in the
  ;; first time GetDOSEnvironment is called and zero until then. It has to be a
  ;; real arena slot rather than a WAT-private buffer: the caller gets a far
  ;; pointer and walks it with 16-bit code.
  (global $win16_env_seg (mut i32) (i32.const 0))
  ;; The DOS disk transfer area as a far pointer, zero until first asked for.
  (global $win16_dta (mut i32) (i32.const 0))
  ;; ESP as the dispatcher found it, so --trace-win16 can report how much each
  ;; API actually popped.
  (global $win16_entry_esp (mut i32) (i32.const 0))
  ;; Which module the resource call in flight is about, from its hInstance:
  ;; 1 = the task's own image, 0x10000|id = one of its DLLs, 0 = follow CS.
  ;; Set by the Win16 resource APIs around a lookup and cleared afterwards,
  ;; because everything else that walks resources — the icon extractor, the
  ;; dialog loader — is already about the image its code is running from.
  (global $win16_res_module_id (mut i32) (i32.const 0))
  ;; Where the last resource found sits in its module's file.
  (global $win16_res_file_off (mut i32) (i32.const 0))
  ;; Scratch for the widened wvsprintf argument list — 32 dwords, allocated on
  ;; first use because most tasks never format anything.
  (global $win16_va_scratch (mut i32) (i32.const 0))
  ;; Highest 16-bit handle handed out so far (see $win16_h16 in
  ;; src/09e-win16-api.wat). Indices are 1-based so that 0 stays NULL in both
  ;; handle spaces. The table itself is the one arena slot no selector can
  ;; name — index WIN16_SEG_MAX — which is why it needs no address here.
  (global $win16_handle_next (mut i32) (i32.const 0))
  ;; Resource handles need the module as well as the NE type/id key. The
  ;; descriptor table is reset with the ordinary Win16 handle table.
  (global $win16_res_handle_next (mut i32) (i32.const 0))
  (global $WIN16_RES_HANDLE_MAX i32 (i32.const 1024))
  (global $WIN16_HANDLE_MAX i32 (i32.const 4096))
  ;; Indices start here so a small integer an app writes where a handle goes --
  ;; COLOR_WINDOW+1 in a class background -- can never collide with one.
  (global $WIN16_HANDLE_BASE i32 (i32.const 0x100))
  ;; --trace-win16: log every dispatch, not only the one that stops the task.
  (global $win16_trace (mut i32) (i32.const 0))
  ;; --trace-fpu: log every x87 exception flag as it is raised or cleared. The
  ;; flags are sticky -- nothing clears them but FCLEX/FINIT -- so a program
  ;; that reads the status word sees whatever the last few thousand
  ;; instructions left there, and "Division by zero" can be reported an
  ;; arbitrary distance from the divide that set ZE.
  (global $fpu_trace (mut i32) (i32.const 0))
  ;; The task's real ESP while a Win16 handler is borrowing the 32-bit stack to
  ;; call a $handle_* — see $win16_call32_begin in src/09e-win16-api.wat.
  (global $win16_esp_save (mut i32) (i32.const 0))
  (global $win16_eip_save (mut i32) (i32.const 0))
  ;; The task's local heap, as offsets within DGROUP: a Win16 local handle is a
  ;; near pointer, so LocalAlloc can only hand out memory the data segment
  ;; already contains. See $win16_LocalAlloc.
  ;; ShowCursor keeps a display count rather than a flag, and apps read it back.
  ;; The continuation slot in the thunk segment: an API that handed control to
  ;; a 16-bit window procedure pushes this as the far return address, and
  ;; $win16_dispatch recognises it. Past the end of the thunk table, so no
  ;; import can be assigned it.
  ;; NE DLLs are staged above the task image, one 256KB slot per module id, in
  ;; the upper half of the 8MB PE staging area. A Win16 DLL is a few tens of
  ;; KB, and there are at most nine module ids.
  (global $WIN16_DLL_STAGING i32 (region.addr $PE_STAGING 0x00400000))
  (global $WIN16_DLL_STAGING_STRIDE i32 (i32.const 0x00040000))
  ;; Reusable staging for a module an application ships with itself. Once an
  ;; NE has loaded, its executable segments live in the selector arena and a
  ;; private 64KB metadata copy preserves its header/resource tables, so the
  ;; next LoadLibrary may reuse all six megabytes. Resource-only Civ II packs
  ;; are as large as 3.9MB; fixed one-megabyte-per-id slots cannot represent
  ;; them and also cap the process at six names for no Windows-level reason.
  (global $WIN16_APP_DLL_STAGING i32 (region.addr $WIN16_APP_DLL_STAGING 0))
  (global $WIN16_APP_DLL_STAGING_SIZE i32 (region.size $WIN16_APP_DLL_STAGING))
  (global $WIN16_APP_DLL_STRIDE  i32 (i32.const 0x00100000))
  (global $WIN16_CONT_OFFSET i32 (i32.const 0xFF00))
  ;; The second continuation slot: CreateWindow calls the WH_CALLWNDPROC hook
  ;; before the window's own procedure, so the two returns have to be told
  ;; apart. See $win16_CreateWindow. What each one has to remember lives on the
  ;; task's stack, not here, because these calls nest.
  (global $WIN16_CONT_CWP i32 (i32.const 0xFF10))
  ;; A custom child created through the Win16 call32 bridge returns from its
  ;; synchronous WM_CREATE here so USER can deliver the paired initial
  ;; WM_SIZE before CreateWindow itself returns.
  (global $WIN16_CONT_CREATE_SIZE i32 (i32.const 0xFF80))
  ;; The CWPSTRUCT and CREATESTRUCT the hook is shown, built below SP; a fixed
  ;; size so the continuation can drop them without being told how big they are.
  (global $WIN16_CWP_SCRATCH i32 (i32.const 44))
  ;; A third slot, standing for the window procedure this emulator supplies
  ;; itself. A 16-bit app that subclasses a window is handed the old procedure
  ;; and expects to be able to call it; the built-in one has no address in the
  ;; task's address space, so it gets this far pointer, which comes back through
  ;; $win16_dispatch and lands on DefWindowProc.
  (global $WIN16_BUILTIN_WNDPROC i32 (i32.const 0xFF20))
  ;; A fourth, which is not called but *parked in*: a modal message box takes
  ;; over the task while it is up, and the run loop re-enters this offset every
  ;; pass until the box is dismissed. See $win16_MessageBox.
  (global $WIN16_MODAL_PUMP i32 (i32.const 0xFF30))
  (global $win16_modal_ret (mut i32) (i32.const 0))
  ;; A fifth, parked in the same way, for a dialog built from the task's own
  ;; RT_DIALOG and driven by the task's own DLGPROC. Unlike the modal box above
  ;; this one hands control back to guest code for every message, so each pass
  ;; either dispatches one and comes back here when the procedure returns, or
  ;; finds nothing to do and yields. See $win16_DialogBox in 09e2.
  (global $WIN16_DLG_PUMP i32 (i32.const 0xFF40))
  ;; Where a dialog resumes after its WH_CALLWNDPROC filter has seen the
  ;; WM_NCCREATE that creating it sends — see $win16_dlg_cwp_resume.
  (global $WIN16_DLG_CWP i32 (i32.const 0xFF50))
  ;; NDDEAPI.NDdeGetWindow. A module this emulator implements has no export
  ;; table for GetProcAddress to read, so its one entry point is reached
  ;; through a fixed thunk-segment slot, the same way the pumps above are.
  (global $WIN16_NDDE_GETWINDOW i32 (i32.const 0xFF60))
  ;; DdeConnect waits for a peer that is not in this process, so like a modal
  ;; message box it cannot answer inside the call. It parks EIP here and the
  ;; run loop re-enters this slot each pass until the room answers or the
  ;; attempt runs out. The far return it has to splice back onto is kept
  ;; beside it, exactly as the modal pump keeps $win16_modal_ret.
  (global $WIN16_DDE_PUMP i32 (i32.const 0xFF70))
  (global $win16_dde_ret (mut i32) (i32.const 0))
  ;; The window that answers for network DDE in this emulator — see
  ;; $win16_ndde_window.
  (global $win16_ndde_hwnd (mut i32) (i32.const 0))
  ;; EndDialog's two words. A dialog procedure calls it and then returns, and
  ;; the pump acts on it at that return, so an inner dialog has always consumed
  ;; these before an outer one can look — nesting needs nothing more.
  (global $win16_dlg_ended (mut i32) (i32.const 0))
  (global $win16_dlg_result (mut i32) (i32.const 0))
  ;; The installed WH_CALLWNDPROC filter, as a far pointer selector:offset, and
  ;; the handle SetWindowsHookEx handed out for it. MFC's window objects are
  ;; attached to their HWNDs from inside this hook, so a task that installs one
  ;; and never sees it called has no window objects at all.
  ;; Module ids 1..8 are the system libraries this emulator implements itself;
  ;; anything above is a real NE the host has to stage before it can be loaded.
  (global $WIN16_SYSTEM_MODULES i32 (i32.const 8))
  (global $WIN16_WH_CALLWNDPROC i32 (i32.const 4))
  (global $win16_hook_cwp (mut i32) (i32.const 0))
  (global $win16_cursor_count (mut i32) (i32.const 0))
  ;; A ring of four 32-byte buffers at the bottom of DGROUP, where a message
  ;; that carries a pointer can hand a 16-bit task a struct in its own shape at
  ;; an address one of its own selectors covers. Four, not one, because a
  ;; dialog redraws several owner-draw controls before any of them returns.
  (global $WIN16_MSG_SCRATCH_SIZE i32 (i32.const 128))
  ;; Raised while the 32-bit bridge frame is open, so $win16_arg16 can refuse
  ;; to read an argument off the scratch stack instead of the task's.
  (global $win16_in_call32 (mut i32) (i32.const 0))
  (global $win16_msg_scratch (mut i32) (i32.const 0))
  (global $win16_msg_slot (mut i32) (i32.const 0))
  ;; A LOGFONT and a TEXTMETRIC for EnumFonts to show its callback, in DGROUP
  ;; beside the message scratch and for the same reason: the callback is given
  ;; a far pointer to them and reads them with 16-bit code, so they cannot live
  ;; in this emulator's private memory. 50 + 31 bytes, rounded up.
  (global $WIN16_FONT_SCRATCH_SIZE i32 (i32.const 96))
  (global $win16_font_scratch (mut i32) (i32.const 0))
  (global $win16_lheap_base (mut i32) (i32.const 0))
  (global $win16_lheap_ptr (mut i32) (i32.const 0))
  (global $win16_lheap_end (mut i32) (i32.const 0))
  ;; Linear address of the NE header in the staged file, so a name import can
  ;; find the imported-name table again long after loading, and how much of the
  ;; file was staged, which bounds the resource-table walk.
  (global $win16_ne_off (mut i32) (i32.const 0))
  (global $win16_file_size (mut i32) (i32.const 0))
  (global $win16_res_len (mut i32) (i32.const 0))
  ;; NUL-separated, double-NUL terminated; see the data segment above.
  (global $STATIC_SYS_DLL_NAMES i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000228))
  (global $STATIC_SYS_DIR i32 (region.addr $RESERVED_PAGE_STRINGS 0x0000025C))
  (global $STATIC_SYS_DLL_EXT i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000274))
  ;; Pseudo module handles for those names. They are deliberately outside
  ;; every mapped image so nothing mistakes one for a real base address; the
  ;; only operations defined on them are GetProcAddress (which resolves
  ;; through the API table and ignores the handle) and GetModuleFileName.
  (global $STATIC_SYS_DLL_HANDLE_BASE i32 (i32.const 0x5D110000))
  ;; First index in the name list that belongs to DirectX.
  (global $STATIC_SYS_DLL_FIRST_DX i32 (i32.const 3))
  (global $DX_VERSION_INFO i32 (region.addr $DX_VERSION_INFO 0))
  (global $DX_VERSION_INFO_SIZE i32 (region.size $DX_VERSION_INFO))
  (global $WIN16_NAME_KERNEL   i32 (region.addr $RESERVED_PAGE_STRINGS 0x000000F0))
  (global $WIN16_NAME_USER     i32 (region.addr $RESERVED_PAGE_STRINGS 0x000000F7))
  (global $WIN16_NAME_GDI      i32 (region.addr $RESERVED_PAGE_STRINGS 0x000000FC))
  (global $WIN16_NAME_KEYBOARD i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000100))
  (global $WIN16_NAME_SOUND    i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000109))
  (global $WIN16_NAME_SHELL    i32 (region.addr $RESERVED_PAGE_STRINGS 0x0000010F))
  (global $WIN16_NAME_MMSYSTEM i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000115))
  (global $WIN16_NAME_COMMDLG  i32 (region.addr $RESERVED_PAGE_STRINGS 0x0000011E))
  (global $WIN16_NAME_CARDS    i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000126))
  ;; Appended into the 84 bytes that were free after CARDS, so no earlier
  ;; offset moves — see tools/data_offsets.js, which is how to check that.
  (global $WIN16_NAME_DDEML    i32 (region.addr $RESERVED_PAGE_STRINGS 0x0000012C))
  ;; Not a module — the one SHELL export reached by name rather than ordinal.
  (global $WIN16_NAME_SHELLABOUT i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000132))
  (global $WIN16_NAME_NDDEAPI   i32 (region.addr $RESERVED_PAGE_STRINGS 0x0000013D))
  (global $WIN16_NAME_NDDEGETWINDOW i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000145))
  ;; The 80x87 emulator. Answered here rather than loaded — see $win16_win87em.
  (global $WIN16_NAME_WIN87EM i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000153))
  (global $WIN16_DDE_SHARES i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000160))

  ;; Console screen buffer state (for Telnet etc.)
  ;; Character data at 0x3000 (80×25×2 = 4000 bytes, UTF-16 LE)
  ;; Attribute data at 0x3FA0 (80×25×2 = 4000 bytes)
  (global $console_width (mut i32) (i32.const 80))
  (global $console_height (mut i32) (i32.const 25))
  (global $console_cursor_x (mut i32) (i32.const 0))
  (global $console_cursor_y (mut i32) (i32.const 0))
  (global $console_attr (mut i32) (i32.const 7))  ;; default: white on black
  (global $console_mode (mut i32) (i32.const 3))  ;; ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT
  ;; The console's own top-level window, created the first time anything is
  ;; written to the screen buffer. 0 until then — a process that never prints
  ;; gets no window, which is what Windows does too.
  (global $console_hwnd (mut i32) (i32.const 0))
  (global $CONSOLE_TITLE i32 (region.addr $RESERVED_PAGE_STRINGS 0x00000024))
  (global $CONSOLE_TITLE_MAX i32 (i32.const 128))
  (global $console_cells_ready (mut i32) (i32.const 0))
  (global $console_cursor_visible (mut i32) (i32.const 1))
  (global $console_cursor_size (mut i32) (i32.const 25))  ;; percentage
  (global $console_handle (mut i32) (i32.const 0x00030001))  ;; active screen buffer handle
  ;; The screen-buffer object currently loaded into the legacy console globals.
  ;; The backing pointers are mutable so handle-taking console APIs can operate
  ;; on an inactive buffer and restore the active one before browser painting.
  (global $console_loaded_handle (mut i32) (i32.const 0x00030001))
  (global $console_text_base (mut i32) (region.addr $CONSOLE_TEXT 0x00000000))
  (global $console_attr_base (mut i32) (region.addr $CONSOLE_ATTR 0x00000000))
  ;; $CONSOLE_INPUT's event ring ends at +0x820. The remaining page stores
  ;; eight shared 48-byte screen-buffer records starting at +0x840; +0x14 is
  ;; the active handle. Keeping this state in memory makes browser Workers see
  ;; the same handles and activation order.
  (global $CONSOLE_BUFFER_TABLE i32 (region.addr $CONSOLE_INPUT 0x00000840))
  (global $CONSOLE_BUFFER_ACTIVE i32 (region.addr $CONSOLE_INPUT 0x00000014))
  (global $CONSOLE_BUFFER_MAGIC i32 (i32.const 0x46554243)) ;; "CBUF"
  (global $CONSOLE_BUFFER_STRIDE i32 (i32.const 48))
  (global $CONSOLE_BUFFER_COUNT i32 (i32.const 8))
  (global $CONSOLE_BUFFER_HANDLE_TAG i32 (i32.const 0x00310000))
  ;; 31 process-shared standard-console handle aliases at +0xB00. Each record
  ;; is {generation-tagged handle, canonical stream 1/2/3}; the final dword of
  ;; the 256-byte run is the monotonically increasing generation source.
  (global $CONSOLE_HANDLE_TABLE i32 (region.addr $CONSOLE_INPUT 0x00000B00))
  (global $CONSOLE_HANDLE_COUNT i32 (i32.const 31))
  (global $CONSOLE_HANDLE_STRIDE i32 (i32.const 8))
  (global $CONSOLE_HANDLE_TAG i32 (i32.const 0x00320000))
  (global $ansi_code_page (mut i32) (i32.const 1252))  ;; process ANSI code page
  (global $console_cp (mut i32) (i32.const 437))  ;; input code page
  (global $console_output_cp (mut i32) (i32.const 437))  ;; output code page

  ;; x87 FPU state — registers stored at WASM memory 0x200 (8 × f64 = 64 bytes)
  (global $fpu_top (mut i32) (i32.const 0))   ;; TOP of FPU stack (0-7)
  (global $fpu_cw  (mut i32) (i32.const 0x037F)) ;; Control word (default: all exceptions masked)
  (global $fpu_sw  (mut i32) (i32.const 0))   ;; Status word
  ;; Tag word: 8-bit mask, bit i = physical register i is valid (1) or empty (0).
  ;; x87 spec uses 2 bits per register (00=valid,01=zero,10=special,11=empty); we
  ;; only distinguish valid/empty since we can't represent the other states without
  ;; tracking each value's class. Used for stack overflow/underflow detection.
  (global $fpu_tag (mut i32) (i32.const 0))
  ;; Exact raw payload shadow for FILD m64 values. Delphi/VCL uses
  ;; FILD/FISTP qword pairs as a memcpy fast path; f64 cannot preserve all
  ;; 64 integer bits, so unchanged FILD m64 entries keep their original bytes.
  (global $fpu_raw_tag (mut i32) (i32.const 0)) ;; bit i = physical ST(i) has raw_i64
  (global $fpu_raw0 (mut i64) (i64.const 0))
  (global $fpu_raw1 (mut i64) (i64.const 0))
  (global $fpu_raw2 (mut i64) (i64.const 0))
  (global $fpu_raw3 (mut i64) (i64.const 0))
  (global $fpu_raw4 (mut i64) (i64.const 0))
  (global $fpu_raw5 (mut i64) (i64.const 0))
  (global $fpu_raw6 (mut i64) (i64.const 0))
  (global $fpu_raw7 (mut i64) (i64.const 0))

  ;; MMX registers. On real hardware these alias the x87 mantissas; we keep them
  ;; separate because no guest reads one through the other without an EMMS in
  ;; between, and an independent file costs nothing. i64 rather than v128: the
  ;; MMX code we run is overwhelmingly whole-register moves, boolean ops and
  ;; 64-bit shifts, which are one exact i64 instruction each. See src/06c-mmx.wat.
  (global $mm0 (mut i64) (i64.const 0))
  (global $mm1 (mut i64) (i64.const 0))
  (global $mm2 (mut i64) (i64.const 0))
  (global $mm3 (mut i64) (i64.const 0))
  (global $mm4 (mut i64) (i64.const 0))
  (global $mm5 (mut i64) (i64.const 0))
  (global $mm6 (mut i64) (i64.const 0))
  (global $mm7 (mut i64) (i64.const 0))
  ;; Per-instance XMM state is naturally per guest thread: both cooperative
  ;; and Worker-backed threads execute in distinct WASM instances. Only the
  ;; small SSE base used by SDL2 is decoded today, so CPUID continues to keep
  ;; its SSE feature bit clear until the wider instruction family exists.
  ;; Store each v128 as two i64s: WebAssembly's constant-expression subset
  ;; does not permit a SIMD initializer on every engine we support.
  (global $xmm0l (mut i64) (i64.const 0)) (global $xmm0h (mut i64) (i64.const 0))
  (global $xmm1l (mut i64) (i64.const 0)) (global $xmm1h (mut i64) (i64.const 0))
  (global $xmm2l (mut i64) (i64.const 0)) (global $xmm2h (mut i64) (i64.const 0))
  (global $xmm3l (mut i64) (i64.const 0)) (global $xmm3h (mut i64) (i64.const 0))
  (global $xmm4l (mut i64) (i64.const 0)) (global $xmm4h (mut i64) (i64.const 0))
  (global $xmm5l (mut i64) (i64.const 0)) (global $xmm5h (mut i64) (i64.const 0))
  (global $xmm6l (mut i64) (i64.const 0)) (global $xmm6h (mut i64) (i64.const 0))
  (global $xmm7l (mut i64) (i64.const 0)) (global $xmm7h (mut i64) (i64.const 0))
  ;; CPUID feature advertisement. Zero = the 486DX we have always reported, so
  ;; every guest takes its scalar fallback; 1 = set EDX bit 23 (MMX) and let the
  ;; MMX paths run. Exported so a benchmark can A/B the same build.
  (global $cpu_mmx_enable (mut i32) (i32.const 1))
  ;; How many MMX instructions the guest actually retired. Without this a
  ;; pixel-identical A/B is ambiguous: it could mean the MMX path is correct,
  ;; or that the guest never took it.
  (global $mmx_exec_count (mut i32) (i32.const 0))

  ;; Cosmetic line style phase is reset per LineTo/path and shared across the
  ;; segments of one WAT-rasterized polyline.
  (global $gdi_line_style_phase (mut i32) (i32.const 0))

  ;; Menu loader scratch — used by $menu_load (09c5-menu.wat) while
  ;; walking PE menu resource bytes (UTF-16 MENUITEMTEMPLATE) in two
  ;; passes (count, then write). Single-instance, no recursion across
  ;; menu_load invocations is needed.
  (global $ml_pos          (mut i32) (i32.const 0))  ;; current PE walk pos (WASM addr)
  (global $ml_end          (mut i32) (i32.const 0))  ;; PE walk end (WASM addr)
  (global $ml_bar_count    (mut i32) (i32.const 0))
  (global $ml_struct_size  (mut i32) (i32.const 0))
  (global $ml_string_size  (mut i32) (i32.const 0))
  (global $ml_blob_w       (mut i32) (i32.const 0))
  (global $ml_struct_cur   (mut i32) (i32.const 0))
  (global $ml_string_cur   (mut i32) (i32.const 0))
  (global $ml_label_chars  (mut i32) (i32.const 0))  ;; out from $ml_load_label
  ;; Bytes per character in the menu template being parsed. A PE MENU resource
  ;; stores its labels as UTF-16; an NE one stores the same template with ANSI
  ;; labels, and that is the only difference between the two. Set by $menu_load.
  (global $ml_char_stride  (mut i32) (i32.const 2))

  ;; Menu tracking state — set by $menu_open / cleared by $menu_close.
  ;; Read by $menu_paint_bar (open_idx) and $menu_paint_dropdown (hover)
  ;; via the JS-side compositor as part of every repaint. Only one menu
  ;; can be open at a time across all windows.
  (global $menu_open_hwnd  (mut i32) (i32.const 0))
  (global $menu_open_top   (mut i32) (i32.const -1))
  (global $menu_open_hover (mut i32) (i32.const -1))
  (global $menu_open_sub_hover (mut i32) (i32.const -1))
  (global $menu_open_x     (mut i32) (i32.const -1))
  (global $menu_open_y     (mut i32) (i32.const -1))
  (global $menu_open_popup_blob (mut i32) (i32.const 0)) ;; guest ptr to transient TrackPopupMenu blob for dynamic HMENU

  ;; Currently-dropped combobox hwnd (the COMBO, not the popup). 0 = none open.
  ;; Set by $combobox_open_dropdown / cleared by $combobox_close_dropdown.
  (global $combo_open_hwnd (mut i32) (i32.const 0))

  ;; Set while $combobox_wndproc forwards a navigation key (VK_DOWN/UP/HOME/
  ;; END/PGUP/PGDN) to its inner listbox. The listbox fires LBN_SELCHANGE
  ;; back via WM_COMMAND; the combo uses this flag to suppress the
  ;; click-driven "close on selection" path so keyboard nav can scroll
  ;; through items without dismissing the dropdown.
  (global $combo_kbd_nav_active (mut i32) (i32.const 0))

  ;; Set by ChangeDisplaySettingsA(lpDevMode, CDS_FULLSCREEN) and cleared by
  ;; ChangeDisplaySettingsA(NULL, ...), which is how a non-DirectDraw app says
  ;; "I own the display now" and "I am done" respectively. The compositor reads
  ;; it through get_display_fullscreen: a full-page, chrome-less takeover is
  ;; something the guest has to ask for, never something inferred from the
  ;; shape of a window.
  (global $display_fullscreen (mut i32) (i32.const 0))

  ;; USER remembers the most recently active member of each owner window's
  ;; popup group. This table is process-shared like the HWND/owner records.
  (global $LAST_ACTIVE_POPUP_TABLE i32 (region.addr $LAST_ACTIVE_POPUP_TABLE 0))
  (global $LAST_ACTIVE_POPUP_TABLE_SIZE i32 (region.size $LAST_ACTIVE_POPUP_TABLE))

  ;; Window-station clipboard generation, shared by every guest Worker.
  (global $CLIPBOARD_SEQUENCE i32 (region.addr $CLIPBOARD_SEQUENCE 0))
  (global $CLIPBOARD_SEQUENCE_SIZE i32 (region.size $CLIPBOARD_SEQUENCE))
