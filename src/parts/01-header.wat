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
  ;; GUI host imports — call into JS canvas renderer
  (import "host" "create_window" (func $host_create_window (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; create_window(hwnd, style, x, y, cx, cy, title_ptr, menu_id) → hwnd
  (import "host" "show_window" (func $host_show_window (param i32 i32)))
  ;; show_window(hwnd, cmd)
  (import "host" "create_dialog" (func $host_create_dialog (param i32 i32) (result i32)))
  ;; create_dialog(hwnd, dlg_resource_id) → hwnd
  (import "host" "load_string" (func $host_load_string (param i32 i32 i32) (result i32)))
  ;; load_string(string_id, buf_ptr, buf_len) → chars_written
  (import "host" "set_window_text" (func $host_set_window_text (param i32 i32)))
  ;; set_window_text(hwnd, text_ptr)
  (import "host" "invalidate" (func $host_invalidate (param i32)))
  ;; invalidate(hwnd)
  (import "host" "erase_background" (func $host_erase_background (param i32 i32) (result i32)))
  ;; erase_background(hwnd, hbrBackground) → 1
  (import "host" "move_window" (func $host_move_window (param i32 i32 i32 i32 i32)))
  ;; move_window(hwnd, x, y, w, h)
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
  (import "host" "shell_about" (func $host_shell_about (param i32 i32) (result i32)))
  ;; shell_about(hwnd, szApp_ptr) → result
  (import "host" "set_dlg_item_text" (func $host_set_dlg_item_text (param i32 i32 i32)))
  ;; set_dlg_item_text(hwnd, control_id, text_ptr)
  (import "host" "check_dlg_button" (func $host_check_dlg_button (param i32 i32 i32)))
  ;; check_dlg_button(hwnd, ctrl_id, check_state)
  (import "host" "check_radio_button" (func $host_check_radio_button (param i32 i32 i32 i32)))
  ;; check_radio_button(hwnd, first_id, last_id, check_id)
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
  (import "host" "gdi_select_object" (func $host_gdi_select_object (param i32 i32) (result i32)))
  (import "host" "gdi_delete_object" (func $host_gdi_delete_object (param i32) (result i32)))
  (import "host" "gdi_delete_dc" (func $host_gdi_delete_dc (param i32) (result i32)))
  (import "host" "gdi_rectangle" (func $host_gdi_rectangle (param i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_rectangle(hdc, left, top, right, bottom)
  (import "host" "gdi_fill_rect" (func $host_gdi_fill_rect (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_fill_rect(hdc, left, top, right, bottom, hbrush)
  (import "host" "gdi_ellipse" (func $host_gdi_ellipse (param i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_ellipse(hdc, left, top, right, bottom)
  (import "host" "gdi_move_to" (func $host_gdi_move_to (param i32 i32 i32) (result i32)))
  (import "host" "gdi_line_to" (func $host_gdi_line_to (param i32 i32 i32) (result i32)))
  ;; gdi_line_to(hdc, x, y)
  (import "host" "gdi_arc" (func $host_gdi_arc (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_arc(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd)
  (import "host" "gdi_bitblt" (func $host_gdi_bitblt (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_bitblt(dstDC, dx, dy, w, h, srcDC, sx, sy, rop)

  (import "host" "gdi_stretch_blt" (func $host_gdi_stretch_blt (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_stretch_blt(dstDC, dx, dy, dw, dh, srcDC, sx, sy, sw, sh, rop)
  (import "host" "gdi_scroll_window" (func $host_gdi_scroll_window (param i32 i32 i32) (result i32)))
  ;; gdi_scroll_window(hwnd, dx, dy)



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
  (import "host" "gdi_set_dib_bits" (func $host_gdi_set_dib_bits (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_set_dib_bits(hdc, hBitmap, startScan, numScans, bitsWasmAddr, bmiWasmAddr, colorUse) → numScans
  (import "host" "gdi_set_dib_to_device" (func $host_gdi_set_dib_to_device (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_set_dib_to_device(hdc, xDest, yDest, w, h, xSrc, ySrc, startScan, cLines, bitsWA, bmiWA, colorUse) → cLines

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

  ;; INI file host imports — backed by localStorage
  (import "host" "ini_get_string" (func $host_ini_get_string (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; ini_get_string(appNameWA, keyNameWA, defaultWA, bufGA, bufSize, fileNameWA, isWide) → chars written
  (import "host" "ini_get_int" (func $host_ini_get_int (param i32 i32 i32 i32 i32) (result i32)))
  ;; ini_get_int(appNameWA, keyNameWA, nDefault, fileNameWA, isWide) → int value
  (import "host" "ini_write_string" (func $host_ini_write_string (param i32 i32 i32 i32 i32) (result i32)))
  ;; ini_write_string(appNameWA, keyNameWA, valueWA, fileNameWA, isWide) → BOOL

  (import "host" "get_window_client_size" (func $host_get_window_client_size (param i32) (result i32)))
  ;; get_window_client_size(hwnd) → (clientW | (clientH << 16))

  ;; Math host imports (for FPU transcendentals)
  (import "host" "math_sin" (func $host_math_sin (param f64) (result f64)))
  (import "host" "math_cos" (func $host_math_cos (param f64) (result f64)))
  (import "host" "math_tan" (func $host_math_tan (param f64) (result f64)))
  (import "host" "math_atan2" (func $host_math_atan2 (param f64 f64) (result f64)))

  ;; Thread/event host imports
  (import "host" "create_thread" (func $host_create_thread (param i32 i32 i32) (result i32)))
  (import "host" "exit_thread" (func $host_exit_thread (param i32)))
  (import "host" "create_event" (func $host_create_event (param i32 i32) (result i32)))
  (import "host" "set_event" (func $host_set_event (param i32) (result i32)))
  (import "host" "reset_event" (func $host_reset_event (param i32) (result i32)))
  (import "host" "wait_single" (func $host_wait_single (param i32 i32) (result i32)))

  ;; ---- Memory: imported from host, 512 pages = 32MB initial ----
  (import "host" "memory" (memory 512))
  (export "memory" (memory 0))

  ;; String constants at WASM offset 0x100
  (data (i32.const 0x100) "win.ini\00")

  ;; ============================================================
  ;; MEMORY MAP
  ;; ============================================================
  ;; 0x00000000  4KB     Null page
  ;; 0x00001000  4KB     Decoder scratch / ModRM result area
  ;; 0x00002000  ...     (unused — staging moved below)
  ;; 0x00012000  14MB    Guest address space (PE sections + DLLs)
  ;; 0x00E12000  1MB     Guest stack (ESP starts at top)
  ;; 0x00F12000  1MB     Guest heap
  ;; 0x01012000  256KB   IAT thunk zone
  ;; 0x01052000  1MB     Thread cache
  ;; 0x01152000  64KB    Block cache index (4096 slots × 16 bytes)
  ;; 0x01162000  2MB     PE staging area (supports PEs up to 2MB)
  ;; 0x01362000  16KB    API dispatch hash table (up to 2048 entries)
  ;; 0x01366000  512B    DLL table (16 DLLs × 32 bytes)
  ;; 0x01366200  ...     Free

  ;; Memory region bases
  (global $PE_STAGING   i32 (i32.const 0x01162000))
  (global $GUEST_BASE   i32 (i32.const 0x00012000))
  (global $GUEST_STACK  i32 (i32.const 0x00E12000))
  (global $THUNK_BASE   i32 (i32.const 0x01012000))
  (global $THUNK_END    i32 (i32.const 0x01052000))
  ;; Guest-space thunk bounds (set by PE loader: THUNK_BASE/END - GUEST_BASE + image_base)
  (global $thunk_guest_base (mut i32) (i32.const 0))
  (global $thunk_guest_end  (mut i32) (i32.const 0))
  (global $THREAD_BASE  (mut i32) (i32.const 0x01052000))
  (global $CACHE_INDEX  (mut i32) (i32.const 0x01152000))
  (global $API_HASH_TABLE i32 (i32.const 0x01362000))
  ;; API_HASH_COUNT is now in 01b-api-hashes.generated.wat

  ;; Guest code section bounds (set by PE loader)
  (global $code_start (mut i32) (i32.const 0))
  (global $code_end   (mut i32) (i32.const 0))

  ;; Thread cache bump allocator
  (global $thread_alloc (mut i32) (i32.const 0x01052000))

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
  (global $heap_ptr (mut i32) (i32.const 0x00F12000))
  (global $free_list (mut i32) (i32.const 0))  ;; WASM-space head of free list (0 = empty)
  (global $fake_cmdline_addr (mut i32) (i32.const 0))
  ;; MSVCRT static data pointers (allocated on first use from heap)
  (global $msvcrt_fmode_ptr   (mut i32) (i32.const 0))
  (global $msvcrt_commode_ptr (mut i32) (i32.const 0))
  (global $msvcrt_acmdln_ptr  (mut i32) (i32.const 0))
  (global $msvcrt_wcmdln_ptr (mut i32) (i32.const 0))  ;; wide command line pointer
  ;; Guest-space address of catch-return thunk (set during PE load)
  (global $catch_ret_thunk (mut i32) (i32.const 0))
  (global $clipboard_format_counter (mut i32) (i32.const 0xBFFF))
  ;; _initterm trampoline state
  (global $initterm_ptr (mut i32) (i32.const 0))  ;; current position in fn ptr table
  (global $initterm_end (mut i32) (i32.const 0))  ;; end of fn ptr table
  (global $initterm_ret (mut i32) (i32.const 0))  ;; original caller return address
  (global $initterm_thunk (mut i32) (i32.const 0)) ;; guest addr of initterm-return thunk
  ;; DLL loader state
  (global $dll_count (mut i32) (i32.const 0))
  (global $DLL_TABLE i32 (i32.const 0x01366000))  ;; 32 bytes x 16 DLLs = 512 bytes (after 16KB hash table)
  (global $exe_size_of_image (mut i32) (i32.const 0))
  ;; rand() state
  (global $rand_seed (mut i32) (i32.const 12345))
  ;; TLS: simple fixed-size TLS (64 slots), allocated in heap on first use
  (global $tls_slots (mut i32) (i32.const 0))  ;; guest ptr to 64 x i32 = 256 bytes
  (global $tls_next_index (mut i32) (i32.const 0))
  ;; FS segment base — points to fake TIB (allocated from heap during PE load)
  (global $fs_base (mut i32) (i32.const 0))
  ;; Current segment prefix during decoding (set before decode_modrm)
  (global $d_seg (mut i32) (i32.const 0))

  ;; Runtime EA temp for SIB addressing
  (global $ea_temp (mut i32) (i32.const 0))

  ;; Window system state
  (global $wndproc_addr (mut i32) (i32.const 0))    ;; WndProc for main window (guest VA)
  (global $wndproc_addr2 (mut i32) (i32.const 0))   ;; WndProc for child/status window
  (global $wndclass_bg_brush (mut i32) (i32.const 0)) ;; hbrBackground from first RegisterClass
  (global $wndclass_style (mut i32) (i32.const 0))    ;; class style from first RegisterClass
  ;; (removed: $window_dc_hwnd — hwnd is now encoded in DC handle)
  (global $capture_hwnd (mut i32) (i32.const 0))      ;; hwnd that has mouse capture (SetCapture/ReleaseCapture)
  (global $cursor_count (mut i32) (i32.const 0))      ;; ShowCursor display count (>=0 = visible)
  (global $win_ini_name_ptr i32 (i32.const 0x100))   ;; WASM ptr to "win.ini\0" string constant
  (global $main_hwnd    (mut i32) (i32.const 0))    ;; Main window handle
  (global $next_hwnd    (mut i32) (i32.const 0x10001)) ;; HWND allocator
  (global $pending_wm_create (mut i32) (i32.const 0)) ;; deliver WM_CREATE as next GetMessageA
  (global $pending_wm_size   (mut i32) (i32.const 0)) ;; deliver WM_SIZE after WM_CREATE (lParam=cx|cy<<16)
  (global $main_win_cx       (mut i32) (i32.const 0)) ;; main window width (from CreateWindowExA)
  (global $main_win_cy       (mut i32) (i32.const 0)) ;; main window height
  (global $main_nc_height    (mut i32) (i32.const 25)) ;; non-client height: 25 (no menu) or 45 (with menu)
  ;; Posted message queue: up to 8 messages, each = (hwnd, msg, wParam, lParam) = 16 bytes
  ;; Stored at fixed WASM address 0x400 (well below guest memory)
  (global $post_queue_count (mut i32) (i32.const 0))
  (global $msg_phase    (mut i32) (i32.const 0))    ;; Message loop phase
  (global $quit_flag    (mut i32) (i32.const 0))    ;; Set by PostQuitMessage
  (global $yield_flag   (mut i32) (i32.const 0))    ;; Set by GetMessageA when no input; cleared by run()
  (global $paint_pending (mut i32) (i32.const 0))    ;; Set by InvalidateRect, cleared when WM_PAINT sent
  (global $child_paint_hwnd (mut i32) (i32.const 0)) ;; Child window needing WM_PAINT (0=none)
  (global $pending_child_create (mut i32) (i32.const 0)) ;; Child hwnd needing WM_CREATE (0=none)
  (global $pending_child_size   (mut i32) (i32.const 0)) ;; Child WM_SIZE lParam (cx|cy<<16, 0=none)
  (global $timer_id     (mut i32) (i32.const 0))    ;; Active timer ID (0 = none)
  (global $timer_hwnd   (mut i32) (i32.const 0))    ;; Timer window handle
  (global $timer_callback (mut i32) (i32.const 0))  ;; Timer callback address (0 = WM_TIMER to window)
  ;; Thread yield state (for multi-instance threading)
  (global $yield_reason (mut i32) (i32.const 0))  ;; 0=none, 1=waiting, 2=exited
  (global $wait_handle  (mut i32) (i32.const 0))
  (global $last_error   (mut i32) (i32.const 0))    ;; GetLastError value
  (global $haccel       (mut i32) (i32.const 0))    ;; Accelerator table handle
  (global $dlg_hwnd     (mut i32) (i32.const 0))    ;; Dialog window handle

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

  ;; x87 FPU state — registers stored at WASM memory 0x200 (8 × f64 = 64 bytes)
  (global $fpu_top (mut i32) (i32.const 0))   ;; TOP of FPU stack (0-7)
  (global $fpu_cw  (mut i32) (i32.const 0x037F)) ;; Control word (default: all exceptions masked)
  (global $fpu_sw  (mut i32) (i32.const 0))   ;; Status word

