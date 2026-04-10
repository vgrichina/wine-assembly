(module
  ;; ============================================================
  ;; Wine-Assembly: Windows 98 PE interpreter in raw WAT
  ;; Forth-style threaded code x86 interpreter — full i486 ISA
  ;; ============================================================

  ;; ---- Host imports ----
  (import "host" "log" (func $host_log (param i32 i32)))
  (import "host" "log_i32" (func $host_log_i32 (param i32)))
  (import "host" "crash_unimplemented" (func $host_crash_unimplemented (param i32 i32 i32 i32)))
  (import "host" "message_box" (func $host_message_box (param i32 i32 i32 i32) (result i32)))
  (import "host" "exit" (func $host_exit (param i32)))
  (import "host" "draw_rect" (func $host_draw_rect (param i32 i32 i32 i32 i32)))
  (import "host" "read_file" (func $host_read_file (param i32 i32 i32) (result i32)))
  (import "host" "help_open" (func $host_help_open (param i32) (result i32)))
  (import "host" "help_get_topic" (func $host_help_get_topic (param i32 i32 i32) (result i32)))
  (import "host" "help_get_title" (func $host_help_get_title (param i32 i32) (result i32)))
  (import "host" "get_ticks" (func $host_get_ticks (result i32)))
  (import "host" "yield" (func $host_yield (param i32)))
  (import "host" "resolve_ordinal" (func $host_resolve_ordinal (param i32 i32) (result i32)))
  ;; resolve_ordinal(dll_name_ptr, ordinal) → api_id (-1 if unknown)
  ;; GUI host imports — call into JS canvas renderer
  (import "host" "create_window" (func $host_create_window (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; create_window(hwnd, style, x, y, cx, cy, title_ptr, menu_id) → hwnd
  (import "host" "show_window" (func $host_show_window (param i32 i32)))
  ;; show_window(hwnd, cmd)
  (import "host" "create_dialog" (func $host_create_dialog (param i32 i32 i32) (result i32)))
  ;; create_dialog(hwnd, dlg_resource_id) → hwnd
  (import "host" "load_string" (func $host_load_string (param i32 i32 i32) (result i32)))
  ;; load_string(string_id, buf_ptr, buf_len) → chars_written
  (import "host" "set_window_text" (func $host_set_window_text (param i32 i32)))
  ;; set_window_text(hwnd, text_ptr)
  (import "host" "invalidate" (func $host_invalidate (param i32)))
  ;; invalidate(hwnd)
  (import "host" "erase_background" (func $host_erase_background (param i32 i32) (result i32)))
  ;; erase_background(hwnd, hbrBackground) → 1
  (import "host" "move_window" (func $host_move_window (param i32 i32 i32 i32 i32 i32)))
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
  (import "host" "check_input_hwnd" (func $host_check_input_hwnd (result i32)))
  ;; check_input_hwnd() → hwnd of last check_input event (0 = use main_hwnd)
  (import "host" "set_window_class" (func $host_set_window_class (param i32 i32)))
  ;; set_window_class(hwnd, class_name_ptr)
  (import "host" "set_menu" (func $host_set_menu (param i32 i32)))
  ;; set_menu(hwnd, menu_resource_id)
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
  (import "host" "set_dlg_item_text" (func $host_set_dlg_item_text (param i32 i32 i32)))
  ;; set_dlg_item_text(hwnd, control_id, text_ptr)
  (import "host" "richedit_stream" (func $host_richedit_stream (param i32 i32)))
  ;; richedit_stream(ctrl_hwnd, text_wasm_ptr) — set RichEdit control text
  (import "host" "check_dlg_button" (func $host_check_dlg_button (param i32 i32 i32)))
  ;; check_dlg_button(hwnd, ctrl_id, check_state)
  (import "host" "is_dlg_button_checked" (func $host_is_dlg_button_checked (param i32 i32) (result i32)))
  ;; is_dlg_button_checked(hwnd, ctrl_id) → 0=unchecked, 1=checked
  (import "host" "send_ctrl_msg" (func $host_send_ctrl_msg (param i32 i32 i32 i32)))
  ;; send_ctrl_msg(ctrl_hwnd, msg, wParam, lParam) — forward control messages to renderer
  (import "host" "check_radio_button" (func $host_check_radio_button (param i32 i32 i32 i32)))
  ;; check_radio_button(hwnd, first_id, last_id, check_id)
  (import "host" "get_dlg_item_text" (func $host_get_dlg_item_text (param i32 i32 i32 i32) (result i32)))
  ;; get_dlg_item_text(hwnd, ctrl_id, bufWA, maxLen) → chars copied
  (import "host" "get_window_text" (func $host_get_window_text (param i32 i32 i32) (result i32)))
  ;; get_window_text(hwnd, bufWA, maxLen) → chars copied
  (import "host" "get_control_count" (func $host_get_control_count (param i32) (result i32)))
  ;; get_control_count(dlgHwnd) → number of controls in dialog
  (import "host" "get_control_info" (func $host_get_control_info (param i32 i32) (result i32)))
  ;; get_control_info(dlgHwnd, index) → (classEnum << 16) | ctrlId
  (import "host" "register_control" (func $host_register_control (param i32 i32 i32 i32)))
  ;; register_control(dlgHwnd, ctrlIndex, controlHwnd, ctrlId)
  (import "host" "get_screen_size" (func $host_get_screen_size (result i32)))
  ;; get_screen_size() → (width | (height << 16))
  (import "host" "create_font" (func $host_create_font (param i32 i32 i32 i32) (result i32)))
  ;; create_font(height, weight, italic, facePtr) → handle
  (import "host" "measure_text" (func $host_measure_text (param i32 i32 i32) (result i32)))
  ;; measure_text(hdc, textPtr, nCount) → pixel width
  (import "host" "get_text_metrics" (func $host_get_text_metrics (param i32) (result i32)))
  ;; get_text_metrics(hdc) → (height | (aveCharWidth << 16))
  ;; GDI host imports
  (import "host" "gdi_create_pen" (func $host_gdi_create_pen (param i32 i32 i32) (result i32)))
  (import "host" "gdi_create_solid_brush" (func $host_gdi_create_solid_brush (param i32) (result i32)))
  (import "host" "gdi_create_compat_dc" (func $host_gdi_create_compat_dc (param i32) (result i32)))
  (import "host" "gdi_create_compat_bitmap" (func $host_gdi_create_compat_bitmap (param i32 i32 i32) (result i32)))
  (import "host" "gdi_create_bitmap" (func $host_gdi_create_bitmap (param i32 i32 i32 i32) (result i32)))
  ;; gdi_create_bitmap(width, height, bitsPerPixel, lpBitsWasmAddr) → handle
  (import "host" "gdi_create_dib_bitmap" (func $host_gdi_create_dib_bitmap (param i32 i32 i32) (result i32)))
  ;; gdi_create_dib_bitmap(lpbmi_wa, lpbInit_wa, fdwInit) → handle
  (import "host" "gdi_select_object" (func $host_gdi_select_object (param i32 i32) (result i32)))
  (import "host" "gdi_delete_object" (func $host_gdi_delete_object (param i32) (result i32)))
  (import "host" "gdi_delete_dc" (func $host_gdi_delete_dc (param i32) (result i32)))
  (import "host" "gdi_rectangle" (func $host_gdi_rectangle (param i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_rectangle(hdc, left, top, right, bottom)
  (import "host" "gdi_fill_rect" (func $host_gdi_fill_rect (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "host" "gdi_draw_edge" (func $host_gdi_draw_edge (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_gradient_fill_h(hdc, l, t, r, b, colorL, colorR) — horizontal linear gradient.
  ;; Win32 equivalent: GdiGradientFill(GRADIENT_FILL_RECT_H). Used by defwndproc_ncpaint.
  (import "host" "gdi_gradient_fill_h" (func $host_gdi_gradient_fill_h (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_fill_rect(hdc, left, top, right, bottom, hbrush)
  (import "host" "gdi_ellipse" (func $host_gdi_ellipse (param i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_ellipse(hdc, left, top, right, bottom)
  (import "host" "gdi_polygon" (func $host_gdi_polygon (param i32 i32 i32) (result i32)))
  ;; gdi_polygon(hdc, pointsWaPtr, nCount)
  (import "host" "gdi_move_to" (func $host_gdi_move_to (param i32 i32 i32) (result i32)))
  (import "host" "gdi_line_to" (func $host_gdi_line_to (param i32 i32 i32) (result i32)))
  ;; gdi_line_to(hdc, x, y)
  (import "host" "gdi_get_current_object" (func $host_gdi_get_current_object (param i32 i32) (result i32)))
  ;; gdi_get_current_object(hdc, objectType) → handle
  (import "host" "gdi_arc" (func $host_gdi_arc (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_arc(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd)
  (import "host" "gdi_bitblt" (func $host_gdi_bitblt (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_bitblt(dstDC, dx, dy, w, h, srcDC, sx, sy, rop)

  (import "host" "gdi_stretch_blt" (func $host_gdi_stretch_blt (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_stretch_blt(dstDC, dx, dy, dw, dh, srcDC, sx, sy, sw, sh, rop)
  (import "host" "gdi_scroll_window" (func $host_gdi_scroll_window (param i32 i32 i32) (result i32)))
  ;; gdi_scroll_window(hwnd, dx, dy)
  (import "host" "show_find_dialog" (func $host_show_find_dialog (param i32 i32 i32) (result i32)))
  ;; show_find_dialog(dlgHwnd, ownerHwnd, findreplace_guest_addr) → hwnd
  (import "host" "get_prop" (func $host_get_prop (param i32 i32) (result i32)))
  ;; get_prop(hwnd, name_ptr) → value
  (import "host" "set_prop" (func $host_set_prop (param i32 i32 i32) (result i32)))
  ;; set_prop(hwnd, name_ptr, value) → 1
  (import "host" "remove_prop" (func $host_remove_prop (param i32 i32) (result i32)))
  ;; remove_prop(hwnd, name_ptr) → removed value



  (import "host" "gdi_load_bitmap" (func $host_gdi_load_bitmap (param i32 i32) (result i32)))
  (import "host" "gdi_get_object_w" (func $host_gdi_get_object_w (param i32) (result i32)))
  (import "host" "gdi_get_object_h" (func $host_gdi_get_object_h (param i32) (result i32)))
  (import "host" "gdi_set_text_color" (func $host_gdi_set_text_color (param i32 i32) (result i32)))
  (import "host" "gdi_set_bk_color" (func $host_gdi_set_bk_color (param i32 i32) (result i32)))
  (import "host" "gdi_set_bk_mode" (func $host_gdi_set_bk_mode (param i32 i32) (result i32)))
  (import "host" "gdi_text_out" (func $host_gdi_text_out (param i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_text_out(hdc, x, y, textWasmAddr, nCount) → 1
  (import "host" "gdi_draw_text" (func $host_gdi_draw_text (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_draw_text(hdc, textWA, nCount, rectWA, uFormat, isWide) → height
  (import "host" "gdi_set_pixel" (func $host_gdi_set_pixel (param i32 i32 i32 i32) (result i32)))
  ;; gdi_set_pixel(hdc, x, y, color) → prev color
  (import "host" "gdi_frame_rect" (func $host_gdi_frame_rect (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_frame_rect(hdc, left, top, right, bottom, hbrush, hwnd) → 1
  (import "host" "gdi_get_pixel" (func $host_gdi_get_pixel (param i32 i32 i32) (result i32)))
  ;; gdi_get_pixel(hdc, x, y) → COLORREF
  (import "host" "gdi_get_di_bits" (func $host_gdi_get_di_bits (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_get_di_bits(hdc, hBitmap, startScan, numScans, bitsGA, bmiWA, colorUse) → numScans
  (import "host" "gdi_set_dib_bits" (func $host_gdi_set_dib_bits (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_set_dib_bits(hdc, hBitmap, startScan, numScans, bitsWasmAddr, bmiWasmAddr, colorUse) → numScans
  (import "host" "gdi_get_dib_color_table" (func $host_gdi_get_dib_color_table (param i32 i32 i32 i32) (result i32)))
  ;; gdi_get_dib_color_table(hdc, startIdx, numEntries, colorsGA) → count
  (import "host" "gdi_set_dib_to_device" (func $host_gdi_set_dib_to_device (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_set_dib_to_device(hdc, xDest, yDest, w, h, xSrc, ySrc, startScan, cLines, bitsWA, bmiWA, colorUse) → cLines
  (import "host" "gdi_stretch_dib_bits" (func $host_gdi_stretch_dib_bits (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_stretch_dib_bits(hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, bitsWA, bmiWA, usage, rop)

  ;; Registry host imports — backed by localStorage
  (import "host" "reg_open_key" (func $host_reg_open_key (param i32 i32 i32) (result i32)))
  ;; reg_open_key(hKey, subKeyWA, isWide) → hKey or 0
  (import "host" "reg_create_key" (func $host_reg_create_key (param i32 i32 i32 i32) (result i32)))
  ;; reg_create_key(hKey, subKeyWA, phkResultGA, isWide) → ERROR_SUCCESS(0) or error
  (import "host" "reg_query_value" (func $host_reg_query_value (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; reg_query_value(hKey, nameWA, typeGA, dataGA, cbDataGA, isWide) → error code
  (import "host" "reg_set_value" (func $host_reg_set_value (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; reg_set_value(hKey, nameWA, type, dataGA, cbData, isWide) → error code
  (import "host" "reg_close_key" (func $host_reg_close_key (param i32) (result i32)))
  ;; reg_close_key(hKey) → 0
  (import "host" "reg_enum_key" (func $host_reg_enum_key (param i32 i32 i32 i32 i32) (result i32)))
  ;; reg_enum_key(hKey, dwIndex, lpNameWA, cchName, isWide) → error code

  ;; Audio host imports
  (import "host" "message_beep" (func $host_message_beep (param i32)))
  ;; message_beep(uType) — play system sound (0=default, 0x10=error, 0x30=warning, 0x40=info)
  (import "host" "play_sound" (func $host_play_sound (param i32 i32)))
  ;; play_sound(wasm_ptr, length) — play WAV data from WASM memory

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

  ;; Math host imports (for FPU transcendentals)
  (import "host" "math_sin" (func $host_math_sin (param f64) (result f64)))
  (import "host" "math_cos" (func $host_math_cos (param f64) (result f64)))
  (import "host" "math_tan" (func $host_math_tan (param f64) (result f64)))
  (import "host" "math_atan2" (func $host_math_atan2 (param f64 f64) (result f64)))

  ;; Filesystem host imports — backed by virtual FS
  (import "host" "fs_create_file" (func $host_fs_create_file (param i32 i32 i32 i32 i32) (result i32)))
  ;; fs_create_file(pathWA, access, creation, flagsAttrs, isWide) → handle
  (import "host" "fs_read_file" (func $host_fs_read_file (param i32 i32 i32 i32) (result i32)))
  ;; fs_read_file(handle, bufGA, nToRead, nReadGA) → BOOL
  (import "host" "fs_write_file" (func $host_fs_write_file (param i32 i32 i32 i32) (result i32)))
  ;; fs_write_file(handle, bufGA, nToWrite, nWrittenGA) → BOOL
  (import "host" "fs_close_handle" (func $host_fs_close_handle (param i32) (result i32)))
  (import "host" "fs_set_file_pointer" (func $host_fs_set_file_pointer (param i32 i32 i32) (result i32)))
  (import "host" "fs_get_file_size" (func $host_fs_get_file_size (param i32) (result i32)))
  (import "host" "fs_get_file_attributes" (func $host_fs_get_file_attributes (param i32 i32) (result i32)))
  (import "host" "fs_set_file_attributes" (func $host_fs_set_file_attributes (param i32 i32 i32) (result i32)))
  (import "host" "fs_delete_file" (func $host_fs_delete_file (param i32 i32) (result i32)))
  (import "host" "fs_create_directory" (func $host_fs_create_directory (param i32 i32) (result i32)))
  (import "host" "fs_remove_directory" (func $host_fs_remove_directory (param i32 i32) (result i32)))
  (import "host" "fs_move_file" (func $host_fs_move_file (param i32 i32 i32) (result i32)))
  (import "host" "fs_copy_file" (func $host_fs_copy_file (param i32 i32 i32 i32) (result i32)))
  (import "host" "fs_find_first_file" (func $host_fs_find_first_file (param i32 i32 i32) (result i32)))
  (import "host" "fs_find_next_file" (func $host_fs_find_next_file (param i32 i32 i32) (result i32)))
  (import "host" "fs_find_close" (func $host_fs_find_close (param i32) (result i32)))
  (import "host" "fs_get_temp_path" (func $host_fs_get_temp_path (param i32 i32 i32) (result i32)))
  (import "host" "fs_get_temp_file_name" (func $host_fs_get_temp_file_name (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "fs_get_current_directory" (func $host_fs_get_current_directory (param i32 i32 i32) (result i32)))
  (import "host" "fs_set_current_directory" (func $host_fs_set_current_directory (param i32 i32) (result i32)))
  (import "host" "fs_get_full_path_name" (func $host_fs_get_full_path_name (param i32 i32 i32 i32 i32) (result i32)))
  (import "host" "fs_get_short_path_name" (func $host_fs_get_short_path_name (param i32 i32 i32 i32) (result i32)))
  (import "host" "fs_create_file_mapping" (func $host_fs_create_file_mapping (param i32 i32 i32 i32) (result i32)))
  ;; fs_create_file_mapping(hFile, protect, sizeHi, sizeLo) → mapping handle
  (import "host" "fs_map_view_of_file" (func $host_fs_map_view_of_file (param i32 i32 i32 i32 i32) (result i32)))
  ;; fs_map_view_of_file(hMapping, access, offsetHi, offsetLo, size) → guest addr
  (import "host" "fs_unmap_view" (func $host_fs_unmap_view (param i32) (result i32)))
  ;; fs_unmap_view(baseAddr) → BOOL

  ;; DLL file check (for dynamic LoadLibrary)
  (import "host" "has_dll_file" (func $host_has_dll_file (param i32) (result i32)))
  ;; has_dll_file(nameWA) → 1 if DLL file exists in VFS/host, 0 if not

  ;; COM host imports
  (import "host" "com_create_instance" (func $host_com_create_instance (param i32 i32 i32 i32 i32) (result i32)))
  ;; com_create_instance(rclsidWA, pUnkOuterGA, dwClsContext, riidWA, ppvGA) → HRESULT
  ;; Returns 0=S_OK, 0x800401F0=CO_E_DLLNOTFOUND (need async load), other=error
  (import "host" "com_get_pending_dll" (func $host_com_get_pending_dll (result i32)))
  ;; com_get_pending_dll() → WASM addr of pending DLL name string (0=none)

  ;; Thread/event host imports
  (import "host" "create_thread" (func $host_create_thread (param i32 i32 i32) (result i32)))
  (import "host" "exit_thread" (func $host_exit_thread (param i32)))
  (import "host" "create_event" (func $host_create_event (param i32 i32) (result i32)))
  (import "host" "set_event" (func $host_set_event (param i32) (result i32)))
  (import "host" "reset_event" (func $host_reset_event (param i32) (result i32)))
  (import "host" "wait_single" (func $host_wait_single (param i32 i32) (result i32)))

  ;; ---- Memory: imported from host, 1024 pages = 64MB initial ----
  (import "host" "memory" (memory 1024))
  (export "memory" (memory 0))

  ;; String constants at WASM offset 0x100
  (data (i32.const 0x100) "win.ini\00Help\00[Contents]\00[Back]\00")
  ;; EXE name buffer at 0x120 (max 128 bytes), default "app.exe"
  (data (i32.const 0x120) "app.exe\00")
  ;; WAT-built find/replace dialog labels (consumed by $create_findreplace_dialog).
  ;; All NUL-terminated, lengths recorded next to the offset constants below.
  (data (i32.const 0x1A0) "Find what:\00")     ;; +0x00, len 10
  (data (i32.const 0x1AB) "Match case\00")     ;; +0x0B, len 10
  (data (i32.const 0x1B6) "Direction\00")      ;; +0x16, len 9
  (data (i32.const 0x1C0) "Up\00")             ;; +0x20, len 2
  (data (i32.const 0x1C3) "Down\00")           ;; +0x23, len 4
  (data (i32.const 0x1C8) "Find Next\00")      ;; +0x28, len 9
  (data (i32.const 0x1D2) "Cancel\00")         ;; +0x32, len 6
  (data (i32.const 0x1D9) "OK\00")             ;; +0x39, len 2  (ShellAbout dialog)
  (data (i32.const 0x1DC) "About \00")         ;; +0x3C, len 6  (ShellAbout title prefix)
  (data (i32.const 0x1E3) "Find\00")           ;; +0x43, len 4  (Find dialog title)
  ;; -- Open/Save common dialog labels --
  (data (i32.const 0x1E8) "Open\00")           ;; +0x48, len 4  (title + button)
  (data (i32.const 0x1ED) "Save As\00")        ;; +0x4D, len 7
  (data (i32.const 0x1F5) "Save\00")           ;; +0x55, len 4  (Save button)
  (data (i32.const 0x1FA) "File name:\00")     ;; +0x5A, len 10
  (data (i32.const 0x205) "Look in:\00")       ;; +0x65, len 8
  (data (i32.const 0x20E) "C:\\*\00")          ;; +0x6E, len 4  (default find pattern)
  (data (i32.const 0x213) "C:\\\00")           ;; +0x73, len 3  (default initial dir)
  (data (i32.const 0x217) "..\00")             ;; +0x77, len 2  (parent dir entry)
  (data (i32.const 0x21A) "Upload...\00")      ;; +0x7A, len 9
  (data (i32.const 0x224) "Download\00")       ;; +0x84, len 8
  (data (i32.const 0x22D) "Not implemented yet\00")  ;; +0x8D, len 19 (stub dialog msg)
  (data (i32.const 0x241) "Page Setup\00")     ;; +0xA1, len 10
  (data (i32.const 0x24C) "Print\00")          ;; +0xAC, len 5
  (data (i32.const 0x252) "Color\00")          ;; +0xB2, len 5
  (data (i32.const 0x258) "Font\00")           ;; +0xB8, len 4
  (data (i32.const 0x25D) "Face:\00")          ;; +0xBD, len 5
  (data (i32.const 0x263) "Style:\00")         ;; +0xC3, len 6
  (data (i32.const 0x26A) "Size:\00")          ;; +0xCA, len 5
  (data (i32.const 0x270) "MS Sans Serif\00")  ;; +0xD0, len 13
  (data (i32.const 0x27E) "Arial\00")          ;; +0xDE, len 5
  (data (i32.const 0x284) "Courier New\00")    ;; +0xE4, len 11
  (data (i32.const 0x290) "Times New Roman\00");; +0xF0, len 15
  (data (i32.const 0x2A0) "Regular\00")        ;; +0x100, len 7
  (data (i32.const 0x2A8) "Bold\00")           ;; +0x108, len 4
  (data (i32.const 0x2AD) "Italic\00")         ;; +0x10D, len 6
  (data (i32.const 0x2B4) "Bold Italic\00")    ;; +0x114, len 11
  (data (i32.const 0x2C0) "8\00")              ;; +0x120
  (data (i32.const 0x2C2) "10\00")             ;; +0x122
  (data (i32.const 0x2C5) "12\00")             ;; +0x125
  (data (i32.const 0x2C8) "14\00")             ;; +0x128
  (data (i32.const 0x2CB) "18\00")             ;; +0x12B
  (data (i32.const 0x2CE) "24\00")             ;; +0x12E

  ;; ============================================================
  ;; MEMORY MAP
  ;; ============================================================
  ;; 0x00000000  4KB     Null page
  ;; 0x00001000  4KB     Decoder scratch / ModRM result area
  ;; 0x00002000  8KB     Free (was old window/class/control tables — moved to 0x7000+)
  ;; 0x00004000  12KB    API dispatch hash table (safe from guest writes via g2w)
  ;; 0x00007000  6KB     WND_RECORDS    (256 entries × 24 bytes, ends 0x8800)
  ;; 0x00008800  4KB     CONTROL_TABLE  (256 entries × 16 bytes, ends 0x9800)
  ;; 0x00009800  2KB     CONTROL_GEOM   (256 entries × 8 bytes,  ends 0xA000)
  ;; 0x0000A000  3KB     CLASS_RECORDS  (64  entries × 48 bytes, ends 0xAC00)
  ;; 0x0000AC00  320B    TIMER_TABLE    (16  entries × 20 bytes, ends 0xAD40)
  ;; 0x0000AD40  16B     PAINT_SCRATCH  (one RECT for control wndproc WM_PAINT)
  ;; 0x0000AD60  1KB     MENU_DATA_TABLE (256 × 4 bytes — heap ptr to per-window menu blob)
  ;; 0x0000B160  28KB    Free (up to GUEST_BASE)
  ;; 0x00012000  28MB    Guest address space (PE sections + DLLs)
  ;; 0x01C12000  1MB     Guest stack (ESP starts at top)
  ;; 0x01D12000  1MB     Guest heap
  ;; 0x01E12000  256KB   IAT thunk zone
  ;; 0x01E52000  4MB     Thread cache
  ;; 0x02252000  64KB    Block cache index (4096 slots × 16 bytes)
  ;; 0x02262000  2MB     PE staging area (supports PEs up to 2MB)
  ;; 0x02462000  512B    DLL table (16 DLLs × 32 bytes)
  ;; 0x02462200  ...     Free

  ;; Memory region bases
  (global $PE_STAGING   i32 (i32.const 0x02262000))
  (global $GUEST_BASE   i32 (i32.const 0x00012000))
  (global $GUEST_STACK  i32 (i32.const 0x01C12000))
  (global $THUNK_BASE   i32 (i32.const 0x01E12000))
  (global $THUNK_END    i32 (i32.const 0x01E52000))
  ;; Guest-space thunk bounds (set by PE loader: THUNK_BASE/END - GUEST_BASE + image_base)
  (global $thunk_guest_base (mut i32) (i32.const 0))
  (global $thunk_guest_end  (mut i32) (i32.const 0))
  (global $THREAD_BASE  (mut i32) (i32.const 0x01E52000))
  (global $CACHE_INDEX  (mut i32) (i32.const 0x02252000))
  (global $API_HASH_TABLE i32 (i32.const 0x00004000))
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
  (global $WND_RECORDS   i32 (i32.const 0x00007000))
  (global $MAX_WINDOWS   i32 (i32.const 256))
  ;; CONTROL_TABLE: per-slot control metadata, parallel-indexed to WND_RECORDS.
  ;; 256 entries × 16 bytes = 0x1000 (0x8800..0x9800)
  (global $CONTROL_TABLE i32 (i32.const 0x00008800))
  ;; CONTROL_GEOM: parallel x/y/w/h table indexed by window slot.
  ;; Stored as 4 × i16 (parent-relative pixels). Populated by
  ;; $ctrl_create_child; consulted by the renderer to enumerate WAT-managed
  ;; child controls without needing host_create_window for each.
  ;; 256 entries × 8 bytes = 0x800 (0x9800..0xA000)
  (global $CONTROL_GEOM  i32 (i32.const 0x00009800))
  ;; CLASS_RECORDS: merged class table + WNDCLASSA storage
  ;;   +0  name_hash (0 = empty slot)
  ;;   +4  atom (assigned at registration)
  ;;   +8  WNDCLASSA[40]  (lpfnWndProc lives at record+12)
  ;; 64 entries × 48 bytes = 0xC00 (0xA000..0xAC00)
  (global $CLASS_RECORDS i32 (i32.const 0x0000A000))
  (global $MAX_CLASSES   i32 (i32.const 64))
  ;; 16-byte RECT scratch used by control wndproc WM_PAINT to call gdi_draw_text
  ;; (which expects a WASM linear address for the rect). Below GUEST_BASE so guest
  ;; cannot reach it via image-relative pointers. Lives just past TIMER_TABLE.
  (global $PAINT_SCRATCH  i32 (i32.const 0x0000AD40))
  ;; MENU_DATA_TABLE — parallel to WND_RECORDS, indexed by window slot.
  ;; Each entry is a guest heap pointer to that window's menu data blob
  ;; (set via $menu_set, read by $menu_paint_bar / $menu_hittest_bar /
  ;; $menu_paint_dropdown / $menu_hittest_dropdown). 0 = no menu.
  ;; Blob layout (heap-resident, owned by WAT):
  ;;   +0       i32  bar_count
  ;;   +4       bar_items[bar_count] × 12 bytes:
  ;;              +0  i32  text_offset (relative to blob base)
  ;;              +4  i32  text_len
  ;;              +8  i32  child_offset (offset to child header, 0 if none)
  ;;   header per child group:
  ;;     +0  i32  child_count
  ;;     +4  child_items[child_count] × 24 bytes:
  ;;              +0  i32 label_offset
  ;;              +4  i32 label_len
  ;;              +8  i32 shortcut_offset
  ;;              +12 i32 shortcut_len
  ;;              +16 i32 flags  (bit0=separator, bit1=grayed)
  ;;              +20 i32 id
  ;;   string bytes appended at the tail
  (global $MENU_DATA_TABLE i32 (i32.const 0x0000AD60))
  (global $WNDPROC_CTRL_NATIVE i32 (i32.const 0xFFFF0002))  ;; WAT-native control wndproc
  (global $CACHE_SIZE    i32 (i32.const 4096))         ;; block cache entries
  (global $CACHE_MASK    i32 (i32.const 0xFFF))        ;; CACHE_SIZE - 1
  (global $SIB_SENTINEL  i32 (i32.const 0xEADEAD))    ;; sentinel for SIB addressing mode
  (global $WNDPROC_WAT_NATIVE i32 (i32.const 0xFFFF0001))  ;; WAT-native window wndproc
  (global $WNDPROC_BUILTIN    i32 (i32.const 0xFFFE0001))  ;; built-in control default wndproc
  ;; API_HASH_COUNT is now in 01b-api-hashes.generated.wat

  ;; Guest code section bounds (set by PE loader)
  (global $code_start (mut i32) (i32.const 0))
  (global $code_end   (mut i32) (i32.const 0))

  ;; Thread cache bump allocator
  (global $thread_alloc (mut i32) (i32.const 0x01E52000))  ;; = THREAD_BASE

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
  (global $dbg_last_push0 (mut i32) (i32.const 0))
  (global $dbg_last_push1 (mut i32) (i32.const 0))
  (global $dbg_prev_eip (mut i32) (i32.const 0))

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

  ;; PE info
  (global $image_base   (mut i32) (i32.const 0))
  (global $entry_point  (mut i32) (i32.const 0))
  (global $num_thunks   (mut i32) (i32.const 0))

  ;; Heap
  (global $heap_ptr (mut i32) (i32.const 0x01D12000))  ;; heap region: 0x01D12000-0x01E12000 (1MB)
  (global $free_list (mut i32) (i32.const 0))  ;; WASM-space head of free list (0 = empty)
  (global $fake_cmdline_addr (mut i32) (i32.const 0))
  (global $exe_name_wa (mut i32) (i32.const 0x120))   ;; WASM addr of exe name string
  (global $exe_name_len (mut i32) (i32.const 7))      ;; length of exe name
  ;; MSVCRT static data pointers (allocated on first use from heap)
  (global $msvcrt_fmode_ptr   (mut i32) (i32.const 0))
  (global $msvcrt_commode_ptr (mut i32) (i32.const 0))
  (global $msvcrt_acmdln_ptr  (mut i32) (i32.const 0))
  (global $msvcrt_wcmdln_ptr (mut i32) (i32.const 0))  ;; wide command line pointer
  ;; Guest-space address of catch-return thunk (set during PE load)
  (global $catch_ret_thunk (mut i32) (i32.const 0))
  ;; Synchronous WM_CREATE: continuation thunk + saved state
  (global $createwnd_ret_thunk (mut i32) (i32.const 0))
  (global $cbt_hook_ret_thunk (mut i32) (i32.const 0)) ;; CBT hook → WM_CREATE continuation
  (global $createwnd_saved_hwnd (mut i32) (i32.const 0))
  (global $createwnd_saved_ret  (mut i32) (i32.const 0))
  (global $focus_hwnd (mut i32) (i32.const 0))
  (global $clipboard_format_counter (mut i32) (i32.const 0xBFFF))
  (global $guid_counter (mut i32) (i32.const 0))
  (global $rgn_counter (mut i32) (i32.const 0))
  ;; _initterm trampoline state
  (global $initterm_ptr (mut i32) (i32.const 0))  ;; current position in fn ptr table
  (global $initterm_end (mut i32) (i32.const 0))  ;; end of fn ptr table
  (global $initterm_ret (mut i32) (i32.const 0))  ;; original caller return address
  (global $initterm_thunk (mut i32) (i32.const 0)) ;; guest addr of initterm-return thunk
  ;; DLL loader state
  (global $dll_count (mut i32) (i32.const 0))
  (global $DLL_TABLE i32 (i32.const 0x02462000))  ;; 32 bytes x 16 DLLs = 512 bytes
  (global $exe_size_of_image (mut i32) (i32.const 0))
  ;; rand() state
  (global $rand_seed (mut i32) (i32.const 12345))
  ;; TLS: simple fixed-size TLS (64 slots), allocated in heap on first use
  (global $tls_slots (mut i32) (i32.const 0))  ;; guest ptr to 64 x i32 = 256 bytes
  (global $tls_next_index (mut i32) (i32.const 0))
  ;; Performance counter (monotonic, incremented per query)
  (global $perf_counter_lo (mut i32) (i32.const 0))
  ;; FS segment base — points to fake TIB (allocated from heap during PE load)
  (global $fs_base (mut i32) (i32.const 0))
  ;; Current segment prefix during decoding (set before decode_modrm)
  (global $d_seg (mut i32) (i32.const 0))

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
  (global $capture_hwnd (mut i32) (i32.const 0))      ;; hwnd that has mouse capture (SetCapture/ReleaseCapture)
  (global $cursor_count (mut i32) (i32.const 0))      ;; ShowCursor display count (>=0 = visible)
  (global $win_ini_name_ptr i32 (i32.const 0x100))   ;; WASM ptr to "win.ini\0" string constant
  (global $main_hwnd    (mut i32) (i32.const 0))    ;; Main window handle
  (global $next_hwnd    (mut i32) (i32.const 0x10001)) ;; HWND allocator
  (global $next_atom    (mut i32) (i32.const 0xC000))  ;; Atom allocator (0xC000+)
  (global $pending_wm_create (mut i32) (i32.const 0)) ;; deliver WM_CREATE as next GetMessageA
  (global $pending_wm_size   (mut i32) (i32.const 0)) ;; deliver WM_SIZE after WM_CREATE (lParam=cx|cy<<16)
  (global $main_win_cx       (mut i32) (i32.const 0)) ;; main window width (from CreateWindowExA)
  (global $main_win_cy       (mut i32) (i32.const 0)) ;; main window height
  (global $main_nc_height    (mut i32) (i32.const 25)) ;; non-client height: 25 (no menu) or 45 (with menu)
  ;; Posted message queue: up to 8 messages, each = (hwnd, msg, wParam, lParam) = 16 bytes
  ;; Stored at fixed WASM address 0x400 (well below guest memory)
  (global $post_queue_count (mut i32) (i32.const 0))
  (global $pq_read_off (mut i32) (i32.const 0))      ;; Read offset for post_queue_dequeue
  (global $msg_phase    (mut i32) (i32.const 0))    ;; Message loop phase
  (global $freelib_last_handle (mut i32) (i32.const 0)) ;; Last FreeLibrary'd handle (for loop detection)
  (global $quit_flag    (mut i32) (i32.const 0))    ;; Set by PostQuitMessage
  (global $yield_flag   (mut i32) (i32.const 0))    ;; Set by GetMessageA when no input; cleared by run()
  (global $paint_pending (mut i32) (i32.const 0))    ;; Set by InvalidateRect, cleared when WM_PAINT sent
  (global $child_paint_hwnd (mut i32) (i32.const 0)) ;; Child window needing WM_PAINT (0=none)
  ;; Paint queue: 16-entry ring at 0xAD50 (64 bytes), head/count globals
  (global $paint_queue_count (mut i32) (i32.const 0))
  (global $PAINT_QUEUE i32 (i32.const 0x0000B200))
  (global $pending_child_create (mut i32) (i32.const 0)) ;; Child hwnd needing WM_CREATE (0=none)
  (global $pending_child_size   (mut i32) (i32.const 0)) ;; Child WM_SIZE lParam (cx|cy<<16, 0=none)
  ;; Timer table at 0xAC00: 16 entries × 20 bytes each (ends 0xAD40)
  ;; Each entry: [hwnd:4][id:4][interval:4][last_tick:4][callback:4]
  ;; Entry with id=0 is unused. Lives just past CLASS_RECORDS (see memory map).
  (global $TIMER_TABLE  i32 (i32.const 0x0000AC00))
  (global $TIMER_MAX    i32 (i32.const 16))
  (global $TIMER_ENTRY_SIZE i32 (i32.const 20))
  (global $timer_count  (mut i32) (i32.const 0))    ;; Number of active timers
  ;; Thread yield state (for multi-instance threading)
  (global $yield_reason (mut i32) (i32.const 0))  ;; 0=none, 1=waiting, 2=exited, 3=com_load_dll, 4=help_load, 5=load_library, 6=modal_dialog
  (global $loadlib_name_ptr (mut i32) (i32.const 0)) ;; guest addr of DLL name for yield=5
  (global $wait_handle  (mut i32) (i32.const 0))
  ;; COM yield state — saved when yielding for async DLL fetch
  (global $com_clsid_ptr (mut i32) (i32.const 0))   ;; guest addr of CLSID
  (global $com_iid_ptr   (mut i32) (i32.const 0))   ;; guest addr of IID
  (global $com_ppv_ptr   (mut i32) (i32.const 0))   ;; guest addr of ppv output
  (global $com_unk_outer (mut i32) (i32.const 0))   ;; pUnkOuter
  (global $com_cls_ctx   (mut i32) (i32.const 0))   ;; dwClsContext
  (global $com_dll_name  (mut i32) (i32.const 0))   ;; WASM addr of DLL name string (from registry)
  (global $last_error   (mut i32) (i32.const 0))    ;; GetLastError value
  (global $haccel       (mut i32) (i32.const 0))    ;; Accelerator table handle
  (global $dlg_hwnd     (mut i32) (i32.const 0))    ;; Dialog window handle
  (global $dlg_result   (mut i32) (i32.const 0))    ;; EndDialog return value
  (global $dlg_ended    (mut i32) (i32.const 0))    ;; Flag: EndDialog was called
  (global $dlg_proc     (mut i32) (i32.const 0))    ;; Dialog proc address
  (global $dlg_ret_addr (mut i32) (i32.const 0))    ;; Return address for DialogBoxParamA
  (global $dlg_loop_thunk (mut i32) (i32.const 0))  ;; Thunk addr for dialog message loop
  (global $class_atom_counter (mut i32) (i32.const 0xC000)) ;; Class atom allocator

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
  (global $modal_loop_thunk (mut i32) (i32.const 0)) ;; CACA0006 thunk addr

  ;; Open / Save dialog: current directory (guest ptr to NUL-terminated
  ;; string). Owns its own heap allocation; replaced via $opendlg_set_dir
  ;; which frees the old buffer first.
  (global $opendlg_current_dir (mut i32) (i32.const 0))

  ;; STEP 6 — find/replace dialog hwnd tracking. Set when $handle_FindTextA
  ;; calls $create_findreplace_dialog. Test bridge queries these via the
  ;; get_findreplace_dlg / get_findreplace_edit exports.
  (global $findreplace_dlg_hwnd  (mut i32) (i32.const 0))
  (global $findreplace_edit_hwnd (mut i32) (i32.const 0))

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
  (global $watch_addr (mut i32) (i32.const 0))
  (global $watch_val  (mut i32) (i32.const 0))
  ;; Tick count (incremented by GetTickCount, starts at ~1 second)
  (global $tick_count (mut i32) (i32.const 1000))

  ;; PE resource directory RVA (set during PE load)
  (global $rsrc_rva (mut i32) (i32.const 0))

  ;; Emulated Windows version for GetVersion/GetVersionEx
  ;; GetVersion format: high word = build (bit 31 set=Win9x, clear=NT), low word = minor<<8|major
  ;; Win98 = 0xC0000A04, NT 4.0 = 0x05650004, Win2000 = 0x08930005
  (global $winver (mut i32) (i32.const 0xC0000A04))

  ;; EIP breakpoint: break when $eip == $bp_addr (0=disabled)
  (global $bp_addr (mut i32) (i32.const 0))

  (global $clipboard_fmt_counter (mut i32) (i32.const 0))

  ;; Console screen buffer state (for Telnet etc.)
  ;; Character data at 0x3000 (80×25×2 = 4000 bytes, UTF-16 LE)
  ;; Attribute data at 0x3FA0 (80×25×2 = 4000 bytes)
  (global $console_width (mut i32) (i32.const 80))
  (global $console_height (mut i32) (i32.const 25))
  (global $console_cursor_x (mut i32) (i32.const 0))
  (global $console_cursor_y (mut i32) (i32.const 0))
  (global $console_attr (mut i32) (i32.const 7))  ;; default: white on black
  (global $console_mode (mut i32) (i32.const 3))  ;; ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT
  (global $console_cursor_visible (mut i32) (i32.const 1))
  (global $console_cursor_size (mut i32) (i32.const 25))  ;; percentage
  (global $console_handle (mut i32) (i32.const 0x00030001))  ;; active screen buffer handle
  (global $console_cp (mut i32) (i32.const 437))  ;; input code page
  (global $console_output_cp (mut i32) (i32.const 437))  ;; output code page

  ;; x87 FPU state — registers stored at WASM memory 0x200 (8 × f64 = 64 bytes)
  (global $fpu_top (mut i32) (i32.const 0))   ;; TOP of FPU stack (0-7)
  (global $fpu_cw  (mut i32) (i32.const 0x037F)) ;; Control word (default: all exceptions masked)
  (global $fpu_sw  (mut i32) (i32.const 0))   ;; Status word

  ;; Palette management
  (global $palette_counter (mut i32) (i32.const 0))   ;; Next palette index
  (global $selected_palette (mut i32) (i32.const 0))  ;; Currently selected HPALETTE

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

  ;; Menu tracking state — set by $menu_open / cleared by $menu_close.
  ;; Read by $menu_paint_bar (open_idx) and $menu_paint_dropdown (hover)
  ;; via the JS-side compositor as part of every repaint. Only one menu
  ;; can be open at a time across all windows.
  (global $menu_open_hwnd  (mut i32) (i32.const 0))
  (global $menu_open_top   (mut i32) (i32.const -1))
  (global $menu_open_hover (mut i32) (i32.const -1))

