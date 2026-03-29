(module
  ;; ============================================================
  ;; Wine-Assembly: Windows 98 PE interpreter in raw WAT
  ;; Forth-style threaded code x86 interpreter — full i486 ISA
  ;; ============================================================

  ;; ---- Host imports ----
  (import "host" "log" (func $host_log (param i32 i32)))
  (import "host" "log_i32" (func $host_log_i32 (param i32)))
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
  ;; GDI host imports
  (import "host" "gdi_create_pen" (func $host_gdi_create_pen (param i32 i32 i32) (result i32)))
  (import "host" "gdi_create_solid_brush" (func $host_gdi_create_solid_brush (param i32) (result i32)))
  (import "host" "gdi_create_compat_dc" (func $host_gdi_create_compat_dc (param i32) (result i32)))
  (import "host" "gdi_create_compat_bitmap" (func $host_gdi_create_compat_bitmap (param i32 i32 i32) (result i32)))
  (import "host" "gdi_select_object" (func $host_gdi_select_object (param i32 i32) (result i32)))
  (import "host" "gdi_delete_object" (func $host_gdi_delete_object (param i32) (result i32)))
  (import "host" "gdi_delete_dc" (func $host_gdi_delete_dc (param i32) (result i32)))
  (import "host" "gdi_rectangle" (func $host_gdi_rectangle (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_rectangle(hdc, left, top, right, bottom, hwnd)
  (import "host" "gdi_ellipse" (func $host_gdi_ellipse (param i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_ellipse(hdc, left, top, right, bottom, hwnd)
  (import "host" "gdi_move_to" (func $host_gdi_move_to (param i32 i32 i32) (result i32)))
  (import "host" "gdi_line_to" (func $host_gdi_line_to (param i32 i32 i32 i32) (result i32)))
  ;; gdi_line_to(hdc, x, y, hwnd)
  (import "host" "gdi_arc" (func $host_gdi_arc (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_arc(hdc, left, top, right, bottom, xStart, yStart, xEnd, yEnd, hwnd)
  (import "host" "gdi_bitblt" (func $host_gdi_bitblt (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
  ;; gdi_bitblt(dstDC, dx, dy, w, h, srcDC, sx, sy, rop, hwnd)

  (import "host" "gdi_load_bitmap" (func $host_gdi_load_bitmap (param i32) (result i32)))
  (import "host" "gdi_get_object_w" (func $host_gdi_get_object_w (param i32) (result i32)))
  (import "host" "gdi_get_object_h" (func $host_gdi_get_object_h (param i32) (result i32)))

  ;; Math host imports (for FPU transcendentals)
  (import "host" "math_sin" (func $host_math_sin (param f64) (result f64)))
  (import "host" "math_cos" (func $host_math_cos (param f64) (result f64)))
  (import "host" "math_tan" (func $host_math_tan (param f64) (result f64)))
  (import "host" "math_atan2" (func $host_math_atan2 (param f64 f64) (result f64)))

  ;; ---- Memory: 512 pages = 32MB initial ----
  (memory (export "memory") 512)

  ;; ============================================================
  ;; MEMORY MAP
  ;; ============================================================
  ;; 0x00000000  4KB     Null page
  ;; 0x00001000  4KB     Decoder scratch / ModRM result area
  ;; 0x00002000  ...     (unused — staging moved below)
  ;; 0x00012000  8MB     Guest address space (PE sections)
  ;; 0x00812000  1MB     Guest stack (ESP starts at top)
  ;; 0x00912000  2MB     Guest heap
  ;; 0x00B12000  256KB   IAT thunk zone
  ;; 0x00B52000  1MB     Thread cache
  ;; 0x00C52000  64KB    Block cache index (4096 slots × 16 bytes)
  ;; 0x00C62000  2MB     PE staging area (supports PEs up to 2MB)
  ;; 0x00E62000  2KB     API dispatch hash table (227 × 8 bytes)
  ;; 0x00E62800  ...     Free

  ;; Memory region bases
  (global $PE_STAGING   i32 (i32.const 0x00C62000))
  (global $GUEST_BASE   i32 (i32.const 0x00012000))
  (global $GUEST_STACK  i32 (i32.const 0x00912000))
  (global $THUNK_BASE   i32 (i32.const 0x00B12000))
  (global $THUNK_END    i32 (i32.const 0x00B52000))
  ;; Guest-space thunk bounds (set by PE loader: THUNK_BASE/END - GUEST_BASE + image_base)
  (global $thunk_guest_base (mut i32) (i32.const 0))
  (global $thunk_guest_end  (mut i32) (i32.const 0))
  (global $THREAD_BASE  i32 (i32.const 0x00B52000))
  (global $CACHE_INDEX  i32 (i32.const 0x00C52000))
  (global $API_HASH_TABLE i32 (i32.const 0x00E62000))
  (global $API_HASH_COUNT i32 (i32.const 348))

  ;; Guest code section bounds (set by PE loader)
  (global $code_start (mut i32) (i32.const 0))
  (global $code_end   (mut i32) (i32.const 0))

  ;; Thread cache bump allocator
  (global $thread_alloc (mut i32) (i32.const 0x00B52000))

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
  (global $heap_ptr (mut i32) (i32.const 0x00912000))
  (global $free_list (mut i32) (i32.const 0))  ;; WASM-space head of free list (0 = empty)
  (global $fake_cmdline_addr (mut i32) (i32.const 0))
  ;; MSVCRT static data pointers (allocated on first use from heap)
  (global $msvcrt_fmode_ptr   (mut i32) (i32.const 0))
  (global $msvcrt_commode_ptr (mut i32) (i32.const 0))
  (global $msvcrt_acmdln_ptr  (mut i32) (i32.const 0))
  (global $msvcrt_wcmdln_ptr (mut i32) (i32.const 0))  ;; wide command line pointer
  ;; Guest-space address of catch-return thunk (set during PE load)
  (global $catch_ret_thunk (mut i32) (i32.const 0))
  ;; _initterm trampoline state
  (global $initterm_ptr (mut i32) (i32.const 0))  ;; current position in fn ptr table
  (global $initterm_end (mut i32) (i32.const 0))  ;; end of fn ptr table
  (global $initterm_ret (mut i32) (i32.const 0))  ;; original caller return address
  (global $initterm_thunk (mut i32) (i32.const 0)) ;; guest addr of initterm-return thunk
  ;; DLL loader state
  (global $dll_count (mut i32) (i32.const 0))
  (global $DLL_TABLE i32 (i32.const 0x00E63000))  ;; 20 bytes x 16 DLLs = 320 bytes
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
  (global $main_hwnd    (mut i32) (i32.const 0))    ;; Main window handle
  (global $next_hwnd    (mut i32) (i32.const 0x10001)) ;; HWND allocator
  (global $pending_wm_create (mut i32) (i32.const 0)) ;; deliver WM_CREATE as next GetMessageA
  (global $pending_wm_size   (mut i32) (i32.const 0)) ;; deliver WM_SIZE after WM_CREATE (lParam=cx|cy<<16)
  (global $main_win_cx       (mut i32) (i32.const 0)) ;; main window width (from CreateWindowExA)
  (global $main_win_cy       (mut i32) (i32.const 0)) ;; main window height
  ;; Posted message queue: up to 8 messages, each = (hwnd, msg, wParam, lParam) = 16 bytes
  ;; Stored at fixed WASM address 0x400 (well below guest memory)
  (global $post_queue_count (mut i32) (i32.const 0))
  (global $msg_phase    (mut i32) (i32.const 0))    ;; Message loop phase
  (global $quit_flag    (mut i32) (i32.const 0))    ;; Set by PostQuitMessage
  (global $yield_flag   (mut i32) (i32.const 0))    ;; Set by GetMessageA when no input; cleared by run()
  (global $paint_pending (mut i32) (i32.const 0))    ;; Set by InvalidateRect, cleared when WM_PAINT sent
  (global $timer_id     (mut i32) (i32.const 0))    ;; Active timer ID (0 = none)
  (global $timer_hwnd   (mut i32) (i32.const 0))    ;; Timer window handle
  (global $timer_callback (mut i32) (i32.const 0))  ;; Timer callback address (0 = WM_TIMER to window)
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

  ;; EIP breakpoint: break when $eip == $bp_addr (0=disabled)
  (global $bp_addr (mut i32) (i32.const 0))

  ;; x87 FPU state — registers stored at WASM memory 0x200 (8 × f64 = 64 bytes)
  (global $fpu_top (mut i32) (i32.const 0))   ;; TOP of FPU stack (0-7)
  (global $fpu_cw  (mut i32) (i32.const 0x037F)) ;; Control word (default: all exceptions masked)
  (global $fpu_sw  (mut i32) (i32.const 0))   ;; Status word

  ;; Static API hash table: 348 entries at 0x00E62000
  ;; Generated by tools/gen_api_table.js — do not edit by hand
  (data (i32.const 0x00E62000)
    "\3a\fd\80\0e\00\00\00\00"  ;; 0: ExitProcess
    "\3c\da\63\e4\01\00\00\00"  ;; 1: GetModuleHandleA
    "\75\77\00\60\02\00\00\00"  ;; 2: GetCommandLineA
    "\3f\bc\ec\57\03\00\00\00"  ;; 3: GetStartupInfoA
    "\25\57\f4\f8\04\00\00\00"  ;; 4: GetProcAddress
    "\37\df\56\50\05\00\00\00"  ;; 5: GetLastError
    "\8f\68\68\42\06\00\00\00"  ;; 6: GetLocalTime
    "\9c\92\ff\6f\07\00\00\00"  ;; 7: GetTimeFormatA
    "\e7\80\91\88\08\00\00\00"  ;; 8: GetDateFormatA
    "\90\c9\0f\21\09\00\00\00"  ;; 9: GetProfileStringA
    "\f8\88\58\69\0a\00\00\00"  ;; 10: GetProfileIntA
    "\10\f2\47\f9\0b\00\00\00"  ;; 11: GetLocaleInfoA
    "\0f\07\b2\53\0c\00\00\00"  ;; 12: LoadLibraryA
    "\77\71\41\82\0d\00\00\00"  ;; 13: DeleteFileA
    "\ce\c9\ca\bd\0e\00\00\00"  ;; 14: CreateFileA
    "\55\2f\48\d7\0f\00\00\00"  ;; 15: FindFirstFileA
    "\e6\c6\35\dd\10\00\00\00"  ;; 16: FindClose
    "\3c\a1\12\76\11\00\00\00"  ;; 17: MulDiv
    "\ff\cb\2a\25\12\00\00\00"  ;; 18: RtlMoveMemory
    "\53\8a\62\50\13\00\00\00"  ;; 19: _lcreat
    "\26\e2\5d\e5\14\00\00\00"  ;; 20: _lopen
    "\01\34\94\df\15\00\00\00"  ;; 21: _lwrite
    "\86\cb\31\69\16\00\00\00"  ;; 22: _llseek
    "\e2\c2\e8\9b\17\00\00\00"  ;; 23: _lclose
    "\de\3c\76\4d\18\00\00\00"  ;; 24: _lread
    "\a8\2c\a6\2f\19\00\00\00"  ;; 25: Sleep
    "\65\00\ba\fa\1a\00\00\00"  ;; 26: CloseHandle
    "\e2\dd\d2\f9\1b\00\00\00"  ;; 27: CreateEventA
    "\39\7e\ac\60\1c\00\00\00"  ;; 28: CreateThread
    "\a4\8c\94\71\1d\00\00\00"  ;; 29: WaitForSingleObject
    "\48\e7\8f\06\1e\00\00\00"  ;; 30: ResetEvent
    "\f1\96\9d\51\1f\00\00\00"  ;; 31: SetEvent
    "\5f\62\7f\a4\20\00\00\00"  ;; 32: WriteProfileStringA
    "\87\81\ba\31\21\00\00\00"  ;; 33: HeapCreate
    "\4f\d0\8d\8e\22\00\00\00"  ;; 34: HeapDestroy
    "\74\ed\84\01\23\00\00\00"  ;; 35: HeapAlloc
    "\3d\0f\63\29\24\00\00\00"  ;; 36: HeapFree
    "\77\5e\a6\53\25\00\00\00"  ;; 37: HeapReAlloc
    "\01\55\28\03\26\00\00\00"  ;; 38: VirtualAlloc
    "\72\cc\9a\3a\27\00\00\00"  ;; 39: VirtualFree
    "\39\43\48\b5\28\00\00\00"  ;; 40: GetACP
    "\c5\25\8c\de\29\00\00\00"  ;; 41: GetOEMCP
    "\18\59\e2\88\2a\00\00\00"  ;; 42: GetCPInfo
    "\c2\f9\53\90\2b\00\00\00"  ;; 43: MultiByteToWideChar
    "\7e\dd\82\e6\2c\00\00\00"  ;; 44: WideCharToMultiByte
    "\89\3f\f0\ce\2d\00\00\00"  ;; 45: GetStringTypeA
    "\7f\29\f0\c0\2e\00\00\00"  ;; 46: GetStringTypeW
    "\fa\a9\5d\3f\2f\00\00\00"  ;; 47: LCMapStringA
    "\58\87\5d\29\30\00\00\00"  ;; 48: LCMapStringW
    "\6a\87\b9\e3\31\00\00\00"  ;; 49: GetStdHandle
    "\41\cf\91\cb\32\00\00\00"  ;; 50: GetFileType
    "\4a\c4\07\7f\33\00\00\00"  ;; 51: WriteFile
    "\d4\f3\40\f5\34\00\00\00"  ;; 52: SetHandleCount
    "\9e\24\c2\cb\35\00\00\00"  ;; 53: GetEnvironmentStrings
    "\3d\c6\fb\99\36\00\00\00"  ;; 54: GetModuleFileNameA
    "\63\65\16\68\37\00\00\00"  ;; 55: UnhandledExceptionFilter
    "\45\a8\d8\6d\38\00\00\00"  ;; 56: GetCurrentProcess
    "\59\ee\4e\f8\39\00\00\00"  ;; 57: TerminateProcess
    "\55\8b\4d\0f\3a\00\00\00"  ;; 58: GetTickCount
    "\89\54\90\3d\3b\00\00\00"  ;; 59: FindResourceA
    "\f9\a8\8c\aa\3c\00\00\00"  ;; 60: LoadResource
    "\ea\23\1e\08\3d\00\00\00"  ;; 61: LockResource
    "\17\0b\87\80\3e\00\00\00"  ;; 62: FreeResource
    "\a0\e4\1b\dc\3f\00\00\00"  ;; 63: RtlUnwind
    "\ee\c5\45\ab\40\00\00\00"  ;; 64: FreeLibrary
    "\b8\a8\e4\b7\41\00\00\00"  ;; 65: sndPlaySoundA
    "\2e\ee\56\ef\42\00\00\00"  ;; 66: RegisterWindowMessageA
    "\eb\58\72\17\43\00\00\00"  ;; 67: CreateWindowExA
    "\8d\cb\5c\0f\44\00\00\00"  ;; 68: CreateDialogParamA
    "\e4\79\a9\23\45\00\00\00"  ;; 69: MessageBoxA
    "\c0\e7\f9\ac\46\00\00\00"  ;; 70: MessageBeep
    "\00\9e\8b\c9\47\00\00\00"  ;; 71: ShowWindow
    "\a8\bc\c7\8b\48\00\00\00"  ;; 72: UpdateWindow
    "\75\62\95\dc\49\00\00\00"  ;; 73: GetMessageA
    "\d4\d4\06\27\4a\00\00\00"  ;; 74: PeekMessageA
    "\69\d1\39\1b\4b\00\00\00"  ;; 75: DispatchMessageA
    "\bf\02\92\dc\4c\00\00\00"  ;; 76: TranslateAcceleratorA
    "\54\85\f2\e2\4d\00\00\00"  ;; 77: TranslateMessage
    "\0b\b1\16\2f\4e\00\00\00"  ;; 78: DefWindowProcA
    "\b7\f1\71\1b\4f\00\00\00"  ;; 79: PostQuitMessage
    "\25\68\65\f3\50\00\00\00"  ;; 80: PostMessageA
    "\1d\87\91\c3\51\00\00\00"  ;; 81: SendMessageA
    "\bd\10\c9\27\52\00\00\00"  ;; 82: SendDlgItemMessageA
    "\dd\86\c4\94\53\00\00\00"  ;; 83: DestroyWindow
    "\3a\54\98\87\54\00\00\00"  ;; 84: DestroyMenu
    "\3e\a2\4f\c8\55\00\00\00"  ;; 85: GetDC
    "\70\4c\e6\9b\56\00\00\00"  ;; 86: GetDeviceCaps
    "\68\14\5b\e6\57\00\00\00"  ;; 87: GetMenu
    "\6c\b6\40\f6\58\00\00\00"  ;; 88: GetSubMenu
    "\29\9f\58\d1\59\00\00\00"  ;; 89: GetSystemMenu
    "\93\7e\32\b0\5a\00\00\00"  ;; 90: GetSystemMetrics
    "\f6\b5\bf\ee\5b\00\00\00"  ;; 91: GetClientRect
    "\73\22\8b\1e\5c\00\00\00"  ;; 92: GetWindowTextA
    "\49\51\4f\1a\5d\00\00\00"  ;; 93: GetWindowRect
    "\14\fa\09\aa\5e\00\00\00"  ;; 94: GetDlgCtrlID
    "\43\c1\0e\bb\5f\00\00\00"  ;; 95: GetDlgItemTextA
    "\97\8a\ba\70\60\00\00\00"  ;; 96: GetDlgItem
    "\09\70\ad\1b\61\00\00\00"  ;; 97: GetCursorPos
    "\b9\6d\ed\c4\62\00\00\00"  ;; 98: GetLastActivePopup
    "\d9\ec\7b\f8\63\00\00\00"  ;; 99: GetFocus
    "\17\ff\4a\29\64\00\00\00"  ;; 100: ReleaseDC
    "\cc\1b\99\76\65\00\00\00"  ;; 101: SetWindowLongA
    "\d7\64\5e\a3\66\00\00\00"  ;; 102: SetWindowTextA
    "\f7\38\f7\47\67\00\00\00"  ;; 103: SetDlgItemTextA
    "\94\bf\b2\03\68\00\00\00"  ;; 104: SetDlgItemInt
    "\e6\f8\b1\80\69\00\00\00"  ;; 105: SetForegroundWindow
    "\21\b8\05\58\6a\00\00\00"  ;; 106: SetCursor
    "\65\d2\99\c3\6b\00\00\00"  ;; 107: SetFocus
    "\e6\3e\50\03\6c\00\00\00"  ;; 108: LoadCursorA
    "\df\6b\1d\0d\6d\00\00\00"  ;; 109: LoadIconA
    "\5f\cc\4d\0a\6e\00\00\00"  ;; 110: LoadStringA
    "\b0\78\a4\c4\6f\00\00\00"  ;; 111: LoadAcceleratorsA
    "\d2\e9\79\dd\70\00\00\00"  ;; 112: EnableWindow
    "\fa\41\4d\52\71\00\00\00"  ;; 113: EnableMenuItem
    "\9a\32\82\13\72\00\00\00"  ;; 114: EndDialog
    "\0e\43\10\93\73\00\00\00"  ;; 115: InvalidateRect
    "\c6\56\69\3a\74\00\00\00"  ;; 116: FillRect
    "\d4\fd\8c\99\75\00\00\00"  ;; 117: FrameRect
    "\a1\a2\a0\9a\76\00\00\00"  ;; 118: LoadBitmapA
    "\e4\ae\4b\bf\77\00\00\00"  ;; 119: OpenIcon
    "\08\82\98\c2\78\00\00\00"  ;; 120: MoveWindow
    "\8c\14\10\9b\79\00\00\00"  ;; 121: CheckMenuRadioItem
    "\67\bc\2a\e9\7a\00\00\00"  ;; 122: CheckMenuItem
    "\ca\54\60\e5\7b\00\00\00"  ;; 123: CheckRadioButton
    "\cc\51\26\7a\7c\00\00\00"  ;; 124: CheckDlgButton
    "\13\2b\08\d4\7d\00\00\00"  ;; 125: CharNextA
    "\2b\ac\5f\be\7e\00\00\00"  ;; 126: CharPrevA
    "\73\2c\c0\18\7f\00\00\00"  ;; 127: IsDialogMessageA
    "\f8\69\65\a5\80\00\00\00"  ;; 128: IsIconic
    "\41\0d\b5\31\81\00\00\00"  ;; 129: ChildWindowFromPoint
    "\1f\2a\62\90\82\00\00\00"  ;; 130: ScreenToClient
    "\23\70\78\cc\83\00\00\00"  ;; 131: TabbedTextOutA
    "\6d\8c\c5\83\84\00\00\00"  ;; 132: WinHelpA
    "\8d\ab\8f\ff\85\00\00\00"  ;; 133: IsChild
    "\b9\ae\e3\d9\86\00\00\00"  ;; 134: GetSysColorBrush
    "\fb\d7\30\30\87\00\00\00"  ;; 135: GetSysColor
    "\82\c6\b1\3d\88\00\00\00"  ;; 136: DialogBoxParamA
    "\2d\a1\14\13\89\00\00\00"  ;; 137: LoadMenuA
    "\44\e8\2d\23\8a\00\00\00"  ;; 138: TrackPopupMenuEx
    "\d8\65\58\44\8b\00\00\00"  ;; 139: OffsetRect
    "\ba\22\4d\47\8c\00\00\00"  ;; 140: MapWindowPoints
    "\ab\d5\b8\83\8d\00\00\00"  ;; 141: SetWindowPos
    "\0f\40\b3\f9\8e\00\00\00"  ;; 142: DrawTextA
    "\be\f6\81\68\8f\00\00\00"  ;; 143: DrawEdge
    "\e7\10\9d\84\90\00\00\00"  ;; 144: GetClipboardData
    "\42\f8\74\8d\91\00\00\00"  ;; 145: SelectObject
    "\81\a5\aa\fc\92\00\00\00"  ;; 146: DeleteObject
    "\8b\92\44\ba\93\00\00\00"  ;; 147: DeleteDC
    "\88\d4\af\17\94\00\00\00"  ;; 148: CreatePen
    "\bc\a0\62\cc\95\00\00\00"  ;; 149: CreateSolidBrush
    "\da\0a\42\d1\96\00\00\00"  ;; 150: CreateCompatibleDC
    "\f0\6f\d3\b9\97\00\00\00"  ;; 151: CreateCompatibleBitmap
    "\8c\bc\46\b7\98\00\00\00"  ;; 152: GetViewportOrgEx
    "\2e\5a\fd\16\99\00\00\00"  ;; 153: Rectangle
    "\10\37\8c\ce\9a\00\00\00"  ;; 154: MoveToEx
    "\f2\f6\9c\f9\9b\00\00\00"  ;; 155: LineTo
    "\f1\45\1e\b6\9c\00\00\00"  ;; 156: Ellipse
    "\7b\55\fb\9c\9d\00\00\00"  ;; 157: Arc
    "\ce\04\79\2a\9e\00\00\00"  ;; 158: BitBlt
    "\e8\4d\35\0d\9f\00\00\00"  ;; 159: PatBlt
    "\5e\38\d0\54\a0\00\00\00"  ;; 160: CreateBitmap
    "\b9\26\c2\ed\a1\00\00\00"  ;; 161: TextOutA
    "\10\b2\ac\85\a2\00\00\00"  ;; 162: GetStockObject
    "\0f\6a\ed\b4\a3\00\00\00"  ;; 163: GetObjectA
    "\ec\19\80\38\a4\00\00\00"  ;; 164: GetTextMetricsA
    "\05\d1\bc\c9\a5\00\00\00"  ;; 165: GetTextExtentPointA
    "\24\5b\26\0e\a6\00\00\00"  ;; 166: GetTextCharset
    "\9d\e1\d8\d7\a7\00\00\00"  ;; 167: CreateFontIndirectA
    "\2b\3e\50\db\a8\00\00\00"  ;; 168: CreateFontA
    "\8b\7f\72\36\a9\00\00\00"  ;; 169: CreateDCA
    "\cf\35\79\95\aa\00\00\00"  ;; 170: SetAbortProc
    "\ff\89\98\a1\ab\00\00\00"  ;; 171: SetBkColor
    "\3b\26\35\1e\ac\00\00\00"  ;; 172: SetBkMode
    "\6b\34\d9\e3\ad\00\00\00"  ;; 173: SetTextColor
    "\f4\df\bf\e8\ae\00\00\00"  ;; 174: SetMenu
    "\dc\50\4c\e3\af\00\00\00"  ;; 175: SetMapMode
    "\63\0c\75\2d\b0\00\00\00"  ;; 176: SetWindowExtEx
    "\34\88\a5\93\b1\00\00\00"  ;; 177: LPtoDP
    "\3e\07\f1\4e\b2\00\00\00"  ;; 178: StartDocA
    "\84\46\41\c0\b3\00\00\00"  ;; 179: StartPage
    "\71\bf\9d\53\b4\00\00\00"  ;; 180: EndPage
    "\a6\1b\da\1a\b5\00\00\00"  ;; 181: EndPaint
    "\94\47\34\80\b6\00\00\00"  ;; 182: EndDoc
    "\a1\8a\f0\1d\b7\00\00\00"  ;; 183: AbortDoc
    "\3b\2e\45\30\b8\00\00\00"  ;; 184: SetCapture
    "\3c\62\83\f2\b9\00\00\00"  ;; 185: ReleaseCapture
    "\5e\32\27\df\ba\00\00\00"  ;; 186: ShowCursor
    "\06\1b\f7\9f\bb\00\00\00"  ;; 187: KillTimer
    "\b8\4f\e8\4e\bc\00\00\00"  ;; 188: SetTimer
    "\95\bc\52\f6\bd\00\00\00"  ;; 189: FindWindowA
    "\09\c7\a4\be\be\00\00\00"  ;; 190: BringWindowToTop
    "\53\28\e6\14\bf\00\00\00"  ;; 191: GetPrivateProfileIntA
    "\30\86\87\d6\c0\00\00\00"  ;; 192: WritePrivateProfileStringA
    "\bf\f5\0f\0b\c1\00\00\00"  ;; 193: ShellExecuteA
    "\91\33\4e\31\c2\00\00\00"  ;; 194: ShellAboutA
    "\21\c4\a8\b6\c3\00\00\00"  ;; 195: SHGetSpecialFolderPathA
    "\fe\72\59\66\c4\00\00\00"  ;; 196: DragAcceptFiles
    "\e2\e3\a7\c3\c5\00\00\00"  ;; 197: DragQueryFileA
    "\2c\6e\5e\7b\c6\00\00\00"  ;; 198: DragFinish
    "\95\9a\62\16\c7\00\00\00"  ;; 199: GetOpenFileNameA
    "\2c\f2\6b\5e\c8\00\00\00"  ;; 200: GetFileTitleA
    "\84\a6\69\f0\c9\00\00\00"  ;; 201: ChooseFontA
    "\30\3c\01\0e\ca\00\00\00"  ;; 202: FindTextA
    "\9f\1e\3b\0c\cb\00\00\00"  ;; 203: PageSetupDlgA
    "\0f\e3\d0\37\cc\00\00\00"  ;; 204: CommDlgExtendedError
    "\85\1a\ed\cd\cd\00\00\00"  ;; 205: exit
    "\36\d5\a6\35\ce\00\00\00"  ;; 206: _exit
    "\7d\f1\0c\14\cf\00\00\00"  ;; 207: __getmainargs
    "\9c\78\4e\bb\d0\00\00\00"  ;; 208: __p__fmode
    "\bf\be\3d\a0\d1\00\00\00"  ;; 209: __p__commode
    "\ee\5f\a5\a2\d2\00\00\00"  ;; 210: _initterm
    "\fd\df\cb\1f\d3\00\00\00"  ;; 211: _controlfp
    "\b6\46\1f\a1\d4\00\00\00"  ;; 212: _strrev
    "\d8\32\0f\dc\d5\00\00\00"  ;; 213: toupper
    "\8b\1b\08\01\d6\00\00\00"  ;; 214: memmove
    "\53\95\2f\89\d7\00\00\00"  ;; 215: strchr
    "\31\2e\15\6e\d8\00\00\00"  ;; 216: _XcptFilter
    "\32\92\3a\f7\d9\00\00\00"  ;; 217: _CxxThrowException
    "\28\d0\2e\99\da\00\00\00"  ;; 218: lstrlenA
    "\e3\36\1a\88\db\00\00\00"  ;; 219: lstrcpyA
    "\75\e7\11\1a\dc\00\00\00"  ;; 220: lstrcatA
    "\61\ee\14\13\dd\00\00\00"  ;; 221: lstrcpynA
    "\dd\d2\8a\25\de\00\00\00"  ;; 222: lstrcmpA
    "\4a\15\42\12\df\00\00\00"  ;; 223: RegCloseKey
    "\1f\db\f6\ba\e0\00\00\00"  ;; 224: RegCreateKeyA
    "\7c\eb\27\90\e1\00\00\00"  ;; 225: RegQueryValueExA
    "\dc\13\51\da\e2\00\00\00"  ;; 226: RegSetValueExA
    "\3d\3c\c3\c2\e3\00\00\00"  ;; 227: LocalAlloc
    "\f6\06\03\bf\e4\00\00\00"  ;; 228: LocalFree
    "\1f\e0\8b\26\e5\00\00\00"  ;; 229: LocalLock
    "\a4\1f\b3\d2\e6\00\00\00"  ;; 230: LocalUnlock
    "\b2\6d\62\47\e7\00\00\00"  ;; 231: LocalReAlloc
    "\0f\7f\ac\3b\e8\00\00\00"  ;; 232: GlobalAlloc
    "\4c\20\ca\60\e9\00\00\00"  ;; 233: GlobalFree
    "\89\42\c8\2a\ea\00\00\00"  ;; 234: GlobalLock
    "\ca\87\76\bf\eb\00\00\00"  ;; 235: GlobalUnlock
    "\68\26\e3\f3\ec\00\00\00"  ;; 236: GlobalReAlloc
    "\2f\ae\c2\7b\ed\00\00\00"  ;; 237: GlobalSize
    "\53\50\82\ee\ee\00\00\00"  ;; 238: GlobalCompact
    "\a3\d8\71\e9\ef\00\00\00"  ;; 239: RegOpenKeyA
    "\1c\a5\f6\0d\f0\00\00\00"  ;; 240: RegOpenKeyExA
    "\24\34\a3\ec\f1\00\00\00"  ;; 241: RegisterClassExA
    "\db\bd\27\eb\f2\00\00\00"  ;; 242: RegisterClassA
    "\92\e8\1c\89\f3\00\00\00"  ;; 243: BeginPaint
    "\85\95\eb\8b\f4\00\00\00"  ;; 244: OpenClipboard
    "\0b\cc\5f\dd\f5\00\00\00"  ;; 245: CloseClipboard
    "\35\4e\6b\94\f6\00\00\00"  ;; 246: IsClipboardFormatAvailable
    "\6b\e8\9f\8b\f7\00\00\00"  ;; 247: GetEnvironmentStringsW
    "\1a\29\86\ba\f8\00\00\00"  ;; 248: GetSaveFileNameA
    "\9d\0e\e9\09\f9\00\00\00"  ;; 249: SetViewportExtEx
    "\ec\ce\c5\c5\fa\00\00\00"  ;; 250: lstrcmpiA
    "\99\c1\33\d1\fb\00\00\00"  ;; 251: FreeEnvironmentStringsA
    "\ef\dd\33\e3\fc\00\00\00"  ;; 252: FreeEnvironmentStringsW
    "\99\57\2f\3a\fd\00\00\00"  ;; 253: GetVersion
    "\12\ef\0c\b4\fe\00\00\00"  ;; 254: GetTextExtentPoint32A
    "\d3\71\b3\78\ff\00\00\00"  ;; 255: wsprintfA
    "\81\4e\1c\88\00\01\00\00"  ;; 256: GetPrivateProfileStringA
    "\3c\76\d9\2d\01\01\00\00"  ;; 257: __wgetmainargs
    "\56\48\bb\91\02\01\00\00"  ;; 258: __p__wcmdln
    "\74\24\db\98\03\01\00\00"  ;; 259: __p__acmdln
    "\f2\7b\56\f2\04\01\00\00"  ;; 260: __set_app_type
    "\23\b4\04\91\05\01\00\00"  ;; 261: __setusermatherr
    "\d3\ae\17\83\06\01\00\00"  ;; 262: _adjust_fdiv
    "\db\ee\b3\99\07\01\00\00"  ;; 263: free
    "\4d\27\8c\55\08\01\00\00"  ;; 264: malloc
    "\03\02\e2\73\09\01\00\00"  ;; 265: calloc
    "\d6\8c\9b\a1\0a\01\00\00"  ;; 266: rand
    "\29\40\bf\1b\0b\01\00\00"  ;; 267: srand
    "\e8\24\eb\8a\0c\01\00\00"  ;; 268: _purecall
    "\87\34\db\5b\0d\01\00\00"  ;; 269: _onexit
    "\c0\a0\94\36\0e\01\00\00"  ;; 270: __dllonexit
    "\4d\e1\fd\1f\0f\01\00\00"  ;; 271: _splitpath
    "\9c\8b\a9\c4\10\01\00\00"  ;; 272: _wcsicmp
    "\ad\b2\96\cb\11\01\00\00"  ;; 273: _wtoi
    "\e9\ec\a5\3f\12\01\00\00"  ;; 274: _itow
    "\e8\6c\97\28\13\01\00\00"  ;; 275: wcscmp
    "\34\5b\c6\84\14\01\00\00"  ;; 276: wcsncpy
    "\3b\9b\e3\a4\15\01\00\00"  ;; 277: wcslen
    "\06\cc\80\cb\16\01\00\00"  ;; 278: memset
    "\64\ec\5c\a4\17\01\00\00"  ;; 279: memcpy
    "\0b\89\ff\0d\18\01\00\00"  ;; 280: __CxxFrameHandler
    "\cb\0d\d5\2f\19\01\00\00"  ;; 281: _global_unwind2
    "\c0\24\78\4e\1a\01\00\00"  ;; 282: _getdcwd
    "\e6\bd\63\d2\1b\01\00\00"  ;; 283: GetModuleHandleW
    "\fb\d5\fb\a3\1c\01\00\00"  ;; 284: GetModuleFileNameW
    "\d3\54\00\4a\1d\01\00\00"  ;; 285: GetCommandLineW
    "\8d\7b\72\2d\1e\01\00\00"  ;; 286: CreateWindowExW
    "\1d\ae\27\e1\1f\01\00\00"  ;; 287: RegisterClassW
    "\2e\4a\a3\fa\20\01\00\00"  ;; 288: RegisterClassExW
    "\ad\d3\16\45\21\01\00\00"  ;; 289: DefWindowProcW
    "\3c\5b\50\15\22\01\00\00"  ;; 290: LoadCursorW
    "\e9\81\1d\1b\23\01\00\00"  ;; 291: LoadIconW
    "\8b\7e\14\fd\24\01\00\00"  ;; 292: LoadMenuW
    "\ee\8f\a9\31\25\01\00\00"  ;; 293: MessageBoxW
    "\e1\7a\5e\b1\26\01\00\00"  ;; 294: SetWindowTextW
    "\15\45\8b\34\27\01\00\00"  ;; 295: GetWindowTextW
    "\db\96\91\cd\28\01\00\00"  ;; 296: SendMessageW
    "\e3\77\65\fd\29\01\00\00"  ;; 297: PostMessageW
    "\34\48\d5\c8\2a\01\00\00"  ;; 298: SetErrorMode
    "\95\fe\cd\eb\2b\01\00\00"  ;; 299: GetCurrentThreadId
    "\b9\ea\b1\41\2c\01\00\00"  ;; 300: LoadLibraryW
    "\49\d2\ec\65\2d\01\00\00"  ;; 301: GetStartupInfoW
    "\f3\bc\12\d3\2e\01\00\00"  ;; 302: GetKeyState
    "\37\9a\32\b8\2f\01\00\00"  ;; 303: GetParent
    "\07\2d\a5\2f\30\01\00\00"  ;; 304: GetWindow
    "\ad\68\75\24\31\01\00\00"  ;; 305: IsWindow
    "\62\e1\e8\60\32\01\00\00"  ;; 306: GetClassInfoW
    "\d6\31\99\84\33\01\00\00"  ;; 307: SetWindowLongW
    "\02\7f\94\e3\34\01\00\00"  ;; 308: GetWindowLongW
    "\f9\70\ad\93\35\01\00\00"  ;; 309: InitCommonControlsEx
    "\5f\af\0b\13\36\01\00\00"  ;; 310: OleInitialize
    "\01\cd\b5\70\37\01\00\00"  ;; 311: CoTaskMemFree
    "\05\cf\59\4b\38\01\00\00"  ;; 312: SaveDC
    "\44\05\f5\92\39\01\00\00"  ;; 313: RestoreDC
    "\f6\2f\80\46\3a\01\00\00"  ;; 314: GetTextMetricsW
    "\5b\f1\d8\e1\3b\01\00\00"  ;; 315: CreateFontIndirectW
    "\45\e5\cf\6e\3c\01\00\00"  ;; 316: SetStretchBltMode
    "\1d\a4\27\7b\3d\01\00\00"  ;; 317: GetPixel
    "\21\08\62\c9\3e\01\00\00"  ;; 318: SetPixel
    "\ca\1b\4d\39\3f\01\00\00"  ;; 319: SetROP2
    "\6a\c0\2e\8f\40\01\00\00"  ;; 320: lstrlenW
    "\25\27\1a\7e\41\01\00\00"  ;; 321: lstrcpyW
    "\9b\e2\8a\2f\42\01\00\00"  ;; 322: lstrcmpW
    "\f6\e4\c5\d3\43\01\00\00"  ;; 323: lstrcmpiW
    "\b5\4d\08\ea\44\01\00\00"  ;; 324: CharNextW
    "\75\94\b3\8e\45\01\00\00"  ;; 325: wsprintfW
    "\5b\79\7f\53\46\01\00\00"  ;; 326: TlsAlloc
    "\87\40\d8\cc\47\01\00\00"  ;; 327: TlsGetValue
    "\f3\b2\0d\7e\48\01\00\00"  ;; 328: TlsSetValue
    "\20\6f\2a\18\49\01\00\00"  ;; 329: TlsFree
    "\05\31\8e\f9\4a\01\00\00"  ;; 330: InitializeCriticalSection
    "\77\40\1b\e9\4b\01\00\00"  ;; 331: EnterCriticalSection
    "\40\d3\0d\c7\4c\01\00\00"  ;; 332: LeaveCriticalSection
    "\52\5f\73\e3\4d\01\00\00"  ;; 333: DeleteCriticalSection
    "\08\a6\c5\9b\4e\01\00\00"  ;; 334: GetCurrentThread
    "\52\86\fe\86\4f\01\00\00"  ;; 335: GetProcessHeap
    "\6e\1c\68\5c\50\01\00\00"  ;; 336: SetStdHandle
    "\a6\95\d1\af\51\01\00\00"  ;; 337: FlushFileBuffers
    "\53\d4\86\76\52\01\00\00"  ;; 338: IsValidCodePage
    "\0d\0b\a0\a1\53\01\00\00"  ;; 339: GetEnvironmentStringsA
    "\7c\08\79\dc\54\01\00\00"  ;; 340: InterlockedIncrement
    "\14\d5\18\09\55\01\00\00"  ;; 341: InterlockedDecrement
    "\ee\5e\4c\af\56\01\00\00"  ;; 342: InterlockedExchange
    "\06\1c\62\61\57\01\00\00"  ;; 343: IsBadReadPtr
    "\03\1a\b4\7e\58\01\00\00"  ;; 344: IsBadWritePtr
    "\cd\23\bf\0a\59\01\00\00"  ;; 345: SetUnhandledExceptionFilter
    "\81\8c\4a\69\5a\01\00\00"  ;; 346: IsDebuggerPresent
    "\57\d8\14\05\5b\01\00\00"  ;; 347: lstrcpynW
  )
  ;; ============================================================
  ;; THREAD HANDLER TABLE
  ;; ============================================================
  ;; New design: fewer, more generic handlers.
  ;; The decoder does ModR/M resolution and emits resolved ops.
  ;;
  ;; Thread word format: [handler_idx:i32, operand:i32] = 8 bytes
  ;; Some handlers read additional i32 words after the thread word.
  ;;
  ;; Register encoding: 0=eax,1=ecx,2=edx,3=ebx,4=esp,5=ebp,6=esi,7=edi
  ;; For byte regs: 0=al,1=cl,2=dl,3=bl,4=ah,5=ch,6=dh,7=bh

  (type $handler_t (func (param i32)))
  (table $handlers 211 funcref)

  (elem (i32.const 0)
    ;; -- Core --
    $th_nop                ;; 0
    $th_next_word          ;; 1: skip (reads+ignores next word), used as spacer
    ;; -- Register-Immediate (operand=reg, imm32 in next word) --
    $th_mov_r_i32          ;; 2
    $th_add_r_i32          ;; 3
    $th_or_r_i32           ;; 4
    $th_adc_r_i32          ;; 5
    $th_sbb_r_i32          ;; 6
    $th_and_r_i32          ;; 7
    $th_sub_r_i32          ;; 8
    $th_xor_r_i32          ;; 9
    $th_cmp_r_i32          ;; 10
    ;; -- Register-Register (operand = dst<<4 | src) --
    $th_mov_r_r            ;; 11
    $th_add_r_r            ;; 12
    $th_or_r_r             ;; 13
    $th_adc_r_r            ;; 14
    $th_sbb_r_r            ;; 15
    $th_and_r_r            ;; 16
    $th_sub_r_r            ;; 17
    $th_xor_r_r            ;; 18
    $th_cmp_r_r            ;; 19
    ;; -- Load/Store 32 (operand = reg, guest_addr in next word) --
    $th_load32             ;; 20: reg = [addr]
    $th_store32            ;; 21: [addr] = reg
    ;; -- Load/Store 16 --
    $th_load16             ;; 22
    $th_store16            ;; 23
    ;; -- Load/Store 8 --
    $th_load8              ;; 24: load byte, zero-extend into reg
    $th_store8             ;; 25: store low byte of reg
    ;; -- Load with reg base + offset (operand=dst<<4|base, disp in next word) --
    $th_load32_ro          ;; 26
    $th_store32_ro         ;; 27
    $th_load8_ro           ;; 28
    $th_store8_ro          ;; 29
    $th_load16_ro          ;; 30
    $th_store16_ro         ;; 31
    ;; -- Stack --
    $th_push_r             ;; 32: push reg
    $th_pop_r              ;; 33: pop reg
    $th_push_i32           ;; 34: push imm32 (in next word)
    $th_pushad             ;; 35
    $th_popad              ;; 36
    $th_pushfd             ;; 37
    $th_popfd              ;; 38
    ;; -- Control flow --
    $th_call_rel           ;; 39: operand=ret_addr, target in next word
    $th_call_ind           ;; 40: operand=ret_addr, mem_addr in next word (reads [mem] for target)
    $th_ret                ;; 41
    $th_ret_imm            ;; 42: operand=bytes to pop
    $th_jmp                ;; 43: operand=ignored, target in next word
    $th_jcc                ;; 44: operand=cc, fall_through+target in next 2 words
    $th_block_end          ;; 45: operand=eip to set
    $th_loop               ;; 46: operand=cc (LOOP/LOOPE/LOOPNE), target in next word, fallthrough in next
    ;; -- ALU memory (operand=alu_op, addr in next word, reg in word after) --
    $th_alu_m32_r          ;; 47: [addr] OP= reg
    $th_alu_r_m32          ;; 48: reg OP= [addr]
    $th_alu_m8_r           ;; 49: [addr] OP= reg (byte)
    $th_alu_r_m8           ;; 50: reg OP= [addr] (byte)
    $th_alu_m32_i32        ;; 51: [addr] OP= imm32 (op, addr, imm in words)
    $th_alu_m8_i8          ;; 52: [addr] OP= imm8
    ;; -- Shifts (operand = reg, shift_type<<8 | count; or count=0 means CL) --
    $th_shift_r            ;; 53: shift/rotate reg by imm or CL
    $th_shift_m32          ;; 54: shift/rotate [addr] (addr in next word)
    ;; -- Multiply/Divide --
    $th_mul32              ;; 55: operand=reg (mul eax by reg, result in edx:eax)
    $th_imul32             ;; 56: signed mul
    $th_div32              ;; 57: unsigned div
    $th_idiv32             ;; 58: signed div
    $th_imul_r_r_i         ;; 59: imul reg, r/m, imm (operand=dst<<4|src, imm in next word)
    $th_mul_m32            ;; 60: mul by [addr] (addr in next word)
    $th_imul_m32           ;; 61
    $th_div_m32            ;; 62
    $th_idiv_m32           ;; 63
    ;; -- Unary (operand = reg) --
    $th_inc_r              ;; 64
    $th_dec_r              ;; 65
    $th_not_r              ;; 66
    $th_neg_r              ;; 67
    ;; -- Unary memory (operand = operation, addr in next word) --
    $th_unary_m32          ;; 68: inc/dec/not/neg [addr]
    $th_unary_m8           ;; 69
    ;; -- LEA (operand = dst reg, addr in next word) --
    $th_lea                ;; 70
    ;; -- XCHG --
    $th_xchg_r_r           ;; 71: operand = r1<<4|r2
    ;; -- TEST --
    $th_test_r_r           ;; 72: operand = r1<<4|r2
    $th_test_r_i32         ;; 73: operand = reg, imm in next word
    $th_test_m32_r         ;; 74: addr in next word, reg in operand
    $th_test_m32_i32       ;; 75: addr+imm in next words
    ;; -- MOV special --
    $th_mov_m32_i32        ;; 76: addr in next word, imm in word after
    $th_mov_m8_i8          ;; 77: addr in next word, imm in operand
    ;; -- MOVZX / MOVSX --
    $th_movzx8             ;; 78: operand=dst, loads byte from addr in next word, zero-extends
    $th_movsx8             ;; 79: sign-extends
    $th_movzx16            ;; 80
    $th_movsx16            ;; 81
    ;; -- String ops --
    $th_rep_movsb          ;; 82
    $th_rep_movsd          ;; 83
    $th_rep_stosb          ;; 84
    $th_rep_stosd          ;; 85
    $th_movsb              ;; 86
    $th_movsd              ;; 87
    $th_stosb              ;; 88
    $th_stosd              ;; 89
    $th_lodsb              ;; 90
    $th_lodsd              ;; 91
    $th_rep_cmpsb          ;; 92
    $th_rep_scasb          ;; 93
    $th_cmpsb              ;; 94
    $th_scasb              ;; 95
    ;; -- Bit ops --
    $th_bt_r_i8            ;; 96: operand=reg, bit in next word
    $th_bts_r_i8           ;; 97
    $th_btr_r_i8           ;; 98
    $th_btc_r_i8           ;; 99
    $th_bsf                ;; 100: operand=dst<<4|src
    $th_bsr                ;; 101
    ;; -- SETcc --
    $th_setcc              ;; 102: operand=cc, addr/reg in next word
    ;; -- SHLD/SHRD --
    $th_shld               ;; 103: operand=dst<<4|src, count in next word
    $th_shrd               ;; 104
    ;; -- Misc --
    $th_cdq                ;; 105: sign-extend eax into edx:eax
    $th_cbw                ;; 106: sign-extend al into ax
    $th_cwde               ;; 107: sign-extend ax into eax
    $th_cld                ;; 108
    $th_std                ;; 109
    $th_clc                ;; 110
    $th_stc                ;; 111
    $th_cmc                ;; 112
    $th_leave              ;; 113
    $th_nop2               ;; 114: multi-byte nop
    $th_bswap              ;; 115: operand=reg
    $th_xchg_eax_r         ;; 116: operand=reg (xchg eax, reg)
    $th_thunk_call         ;; 117: Win32 API dispatch
    $th_imul_r_r           ;; 118: imul reg, r/m (2-operand, operand=dst<<4|src)
    $th_call_r             ;; 119: call reg (operand=ret_addr, reg in next word)
    $th_jmp_r              ;; 120: jmp reg (reg in operand)
    $th_push_m32           ;; 121: push [addr] (addr in next word)
    $th_alu_m16_i16        ;; 122: [addr] OP= imm16
    $th_load8s             ;; 123: load byte, sign-extend (for movsx)
    $th_test_m8_i8         ;; 124: addr in next word, imm in operand
    $th_jmp_ind            ;; 125: jmp [mem] — load target, check thunk, set EIP
    $th_lea_ro             ;; 126: lea dst, [base+disp] (runtime)
    $th_alu_m32_r_ro       ;; 127: [base+disp] OP= reg (runtime EA)
    $th_alu_r_m32_ro       ;; 128: reg OP= [base+disp] (runtime EA)
    $th_alu_m8_r_ro        ;; 129: [base+disp] OP= reg8 (runtime EA)
    $th_alu_r_m8_ro        ;; 130: reg8 OP= [base+disp] (runtime EA)
    $th_alu_m32_i_ro       ;; 131: [base+disp] OP= imm32 (runtime EA)
    $th_alu_m8_i_ro        ;; 132: [base+disp] OP= imm8 (runtime EA)
    $th_mov_m32_i32_ro     ;; 133: [base+disp] = imm32 (op=base, disp+imm in words)
    $th_mov_m8_i8_ro       ;; 134: [base+disp] = imm8
    $th_unary_m32_ro       ;; 135: inc/dec/not/neg [base+disp] (op=unary_op<<4|base, disp in word)
    $th_test_m32_r_ro      ;; 136: test [base+disp], reg (op=reg<<4|base, disp in word)
    $th_test_m32_i32_ro    ;; 137: test [base+disp], imm32 (op=base, disp+imm in words)
    $th_test_m8_i8_ro      ;; 138: test [base+disp], imm8 (op=base, disp+imm in words)
    $th_shift_m32_ro       ;; 139: shift [base+disp] (op=base, shift_info+disp in words)
    $th_call_ind_ro        ;; 140: call [base+disp] (op=ret_addr, base+disp in words)
    $th_jmp_ind_ro         ;; 141: jmp [base+disp] (op=0, base+disp in words)
    $th_push_m32_ro        ;; 142: push [base+disp] (op=base, disp in word)
    $th_movzx8_ro          ;; 143: movzx reg, byte [base+disp] (op=dst<<4|base, disp in word)
    $th_movsx8_ro          ;; 144
    $th_movzx16_ro         ;; 145
    $th_movsx16_ro         ;; 146
    $th_muldiv_m32_ro      ;; 147: mul/imul/div/idiv [base+disp] (op=type<<4|base, disp in word)
    $th_lea_sib            ;; 148: LEA dst, [base+index*scale+disp] (op=dst, base|index<<4|scale<<8 in word, disp in word)
    $th_compute_ea_sib     ;; 149: compute SIB EA → ea_temp, then fall through to next handler (same encoding as 148 but op ignored)
    $th_test_r8_r8         ;; 150: test reg8, reg8 (operand = r1<<4|r2)
    $th_test_m8_r          ;; 151: test [addr], reg8 (operand=reg, addr in next word)
    $th_test_m8_r_ro       ;; 152: test [base+disp], reg8 (op=reg<<4|base, disp in word)
    $th_alu_r8_r8          ;; 153: byte ALU reg8,reg8 (op=alu_op<<8|dst<<4|src)
    $th_alu_r8_i8          ;; 154: byte ALU reg8,imm8 (op=alu_op<<8|reg, imm in next word)
    $th_mov_r8_r8          ;; 155: MOV reg8,reg8 (op=dst<<4|src)
    $th_mov_r8_i8          ;; 156: MOV reg8,imm8 (op=reg, imm in next word)
    $th_imul_r_m_ro        ;; 157: imul reg, [base+disp] (op=reg<<4|base, disp in word)
    $th_imul_r_m_abs       ;; 158: imul reg, [addr] (op=reg, addr in next word)
    $th_alu_r16_m16        ;; 159: r16 OP= [addr] (op=alu_op<<4|reg, addr in next word)
    $th_alu_m16_r16        ;; 160: [addr] OP= r16 (op=alu_op<<4|reg, addr in next word)
    $th_alu_r16_m16_ro     ;; 161: r16 OP= [base+disp] (op=alu_op<<8|reg<<4|base, disp in word)
    $th_alu_m16_r16_ro     ;; 162: [addr] OP= r16 (op=alu_op<<8|reg<<4|base, disp in word)
    $th_mov_m16_r16        ;; 163: mov [addr], r16 (op=reg, addr in next word)
    $th_mov_r16_m16        ;; 164: mov r16, [addr] (op=reg, addr in next word)
    $th_mov_m16_r16_ro     ;; 165: mov [base+disp], r16 (op=reg<<4|base, disp in word)
    $th_mov_r16_m16_ro     ;; 166: mov r16, [base+disp] (op=reg<<4|base, disp in word)
    $th_mov_m16_i16        ;; 167: mov [addr], imm16 (op=0, addr+imm in words)
    $th_mov_m16_i16_ro     ;; 168: mov [base+disp], imm16 (op=base, disp+imm in words)
    ;; -- CMPSD/SCASD --
    $th_rep_cmpsd          ;; 169
    $th_rep_scasd          ;; 170
    $th_cmpsd              ;; 171
    $th_scasd              ;; 172
    ;; -- CMPXCHG/XADD/CPUID --
    $th_cmpxchg            ;; 173: operand=reg, addr in next word (or mod=3: operand=dst<<4|src)
    $th_xadd               ;; 174: same encoding as cmpxchg
    $th_cpuid              ;; 175
    ;; -- Memory BT/BTS/BTR/BTC --
    $th_bt_m_i8            ;; 176: addr in next word, bit in word after
    $th_bts_m_i8           ;; 177
    $th_btr_m_i8           ;; 178
    $th_btc_m_i8           ;; 179
    ;; -- 0x66 prefix helpers --
    $th_cwd                ;; 180: CWD (AX → DX:AX sign extend)
    $th_push_r16           ;; 181: push 16-bit reg (operand=reg)
    $th_pop_r16            ;; 182: pop 16-bit reg
    $th_movsw              ;; 183
    $th_stosw              ;; 184
    $th_lodsw              ;; 185
    $th_rep_movsw          ;; 186
    $th_rep_stosw          ;; 187
    ;; -- x87 FPU --
    $th_fpu_mem            ;; 188
    $th_fpu_reg            ;; 189
    $th_fpu_mem_ro         ;; 190
    ;; -- 8/16-bit shifts --
    $th_shift_r8           ;; 191
    $th_shift_m8           ;; 192
    $th_shift_r16          ;; 193
    $th_shift_m16          ;; 194
    ;; -- CMPXCHG8B --
    $th_cmpxchg8b          ;; 195
    ;; -- XCHG memory --
    $th_xchg_m_r           ;; 196: xchg [addr], reg (op=reg, addr in next word)
    $th_xchg_m_r_ro        ;; 197: xchg [base+disp], reg (op=reg<<4|base, disp in word)
    ;; -- BT/BTS/BTR/BTC r,r --
    $th_bt_r_r             ;; 198: bt reg, reg (op=dst<<4|src)
    $th_bts_r_r            ;; 199: bts reg, reg
    $th_btr_r_r            ;; 200: btr reg, reg
    $th_btc_r_r            ;; 201: btc reg, reg
    ;; -- 16-bit INC/DEC --
    $th_inc_r16            ;; 202: inc r16 (op=reg)
    $th_dec_r16            ;; 203: dec r16 (op=reg)
    ;; -- 16-bit TEST --
    $th_test_r16_r16       ;; 204: test r16, r16 (op=dst<<4|src)
    $th_test_ax_i16        ;; 205: test ax, imm16 (imm in next word)
    ;; -- 16-bit register ALU --
    $th_alu_r16_r16        ;; 206: r16 OP= r16 (op=alu_op<<8|dst<<4|src)
    $th_alu_r16_i16        ;; 207: r16 OP= imm16 (op=alu_op<<4|reg, imm in next word)
    $th_movzx_r_r8         ;; 208: movzx r32, reg8 (op=dst<<4|src_byte_reg)
    $th_movsx_r_r8         ;; 209: movsx r32, reg8 (op=dst<<4|src_byte_reg)
    $th_mov_r16_r16        ;; 210: mov r16, r16 (op=dst<<4|src)
    $th_setcc_mem          ;; 211: SETcc [addr] (op=cc, addr in next word)
  )

  ;; ============================================================
  ;; REGISTER ACCESS
  ;; ============================================================
  (func $get_reg (param $r i32) (result i32)
    (if (i32.eq (local.get $r) (i32.const 0)) (then (return (global.get $eax))))
    (if (i32.eq (local.get $r) (i32.const 1)) (then (return (global.get $ecx))))
    (if (i32.eq (local.get $r) (i32.const 2)) (then (return (global.get $edx))))
    (if (i32.eq (local.get $r) (i32.const 3)) (then (return (global.get $ebx))))
    (if (i32.eq (local.get $r) (i32.const 4)) (then (return (global.get $esp))))
    (if (i32.eq (local.get $r) (i32.const 5)) (then (return (global.get $ebp))))
    (if (i32.eq (local.get $r) (i32.const 6)) (then (return (global.get $esi))))
    (global.get $edi)
  )

  (func $set_reg (param $r i32) (param $v i32)
    (if (i32.eq (local.get $r) (i32.const 0)) (then (global.set $eax (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 1)) (then (global.set $ecx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 2)) (then (global.set $edx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 3)) (then (global.set $ebx (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 4)) (then (global.set $esp (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 5)) (then (global.set $ebp (local.get $v)) (return)))
    (if (i32.eq (local.get $r) (i32.const 6)) (then (global.set $esi (local.get $v)) (return)))
    (global.set $edi (local.get $v))
  )

  ;; Get byte register value (0-3=al/cl/dl/bl, 4-7=ah/ch/dh/bh)
  (func $get_reg8 (param $r i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $r) (i32.const 4))
      (then (i32.and (call $get_reg (local.get $r)) (i32.const 0xFF)))
      (else (i32.and (i32.shr_u (call $get_reg (i32.sub (local.get $r) (i32.const 4))) (i32.const 8)) (i32.const 0xFF))))
  )

  ;; Set byte register (preserves other bits)
  (func $set_reg8 (param $r i32) (param $v i32)
    (local $old i32)
    (if (i32.lt_u (local.get $r) (i32.const 4))
      (then
        (local.set $old (call $get_reg (local.get $r)))
        (call $set_reg (local.get $r) (i32.or (i32.and (local.get $old) (i32.const 0xFFFFFF00)) (i32.and (local.get $v) (i32.const 0xFF)))))
      (else
        (local.set $old (call $get_reg (i32.sub (local.get $r) (i32.const 4))))
        (call $set_reg (i32.sub (local.get $r) (i32.const 4))
          (i32.or (i32.and (local.get $old) (i32.const 0xFFFF00FF))
            (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 8))))))
  )

  ;; Get/set 16-bit register
  (func $get_reg16 (param $r i32) (result i32)
    (i32.and (call $get_reg (local.get $r)) (i32.const 0xFFFF))
  )
  (func $set_reg16 (param $r i32) (param $v i32)
    (call $set_reg (local.get $r)
      (i32.or (i32.and (call $get_reg (local.get $r)) (i32.const 0xFFFF0000))
              (i32.and (local.get $v) (i32.const 0xFFFF))))
  )

  ;; ============================================================
  ;; GUEST MEMORY
  ;; ============================================================
  (func $g2w (param $ga i32) (result i32)
    (local $wa i32)
    (local.set $wa (i32.add (i32.sub (local.get $ga) (global.get $image_base)) (global.get $GUEST_BASE)))
    (if (i32.or (i32.lt_s (local.get $wa) (i32.const 0))
                (i32.ge_u (local.get $wa) (i32.const 0x2000000))) ;; 32MB
      (then
        (call $host_log_i32 (local.get $ga))
        (call $host_log_i32 (local.get $wa))
        (call $host_log_i32 (global.get $eip))
        (return (global.get $GUEST_BASE))))
    (local.get $wa)
  )
  (func $gl32 (param $ga i32) (result i32) (i32.load (call $g2w (local.get $ga))))
  (func $gl16 (param $ga i32) (result i32) (i32.load16_u (call $g2w (local.get $ga))))
  (func $gl8 (param $ga i32) (result i32) (i32.load8_u (call $g2w (local.get $ga))))
  (func $gs32 (param $ga i32) (param $v i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $ga)))
    (if (i32.and (i32.ge_u (local.get $ga) (global.get $code_start))
                 (i32.lt_u (local.get $ga) (global.get $code_end)))
      (then (call $invalidate_page (local.get $ga))))
    (i32.store (local.get $wa) (local.get $v)))
  (func $gs16 (param $ga i32) (param $v i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $ga)))
    (if (i32.and (i32.ge_u (local.get $ga) (global.get $code_start))
                 (i32.lt_u (local.get $ga) (global.get $code_end)))
      (then (call $invalidate_page (local.get $ga))))
    (i32.store16 (local.get $wa) (local.get $v)))
  (func $gs8 (param $ga i32) (param $v i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $ga)))
    (if (i32.and (i32.ge_u (local.get $ga) (global.get $code_start))
                 (i32.lt_u (local.get $ga) (global.get $code_end)))
      (then (call $invalidate_page (local.get $ga))))
    (i32.store8 (local.get $wa) (local.get $v)))

  ;; ============================================================
  ;; LAZY FLAGS
  ;; ============================================================
  (func $set_flags_add (param $a i32) (param $b i32) (param $r i32)
    (global.set $flag_op (i32.const 1)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b)) (global.set $flag_res (local.get $r)))
  (func $set_flags_sub (param $a i32) (param $b i32) (param $r i32)
    (global.set $flag_op (i32.const 2)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b)) (global.set $flag_res (local.get $r)))
  (func $set_flags_logic (param $r i32)
    (global.set $flag_op (i32.const 3)) (global.set $flag_res (local.get $r)))
  (func $set_flags_shift (param $r i32) (param $cf i32)
    (global.set $flag_op (i32.const 7)) (global.set $flag_res (local.get $r))
    (global.set $flag_b (local.get $cf)))
  (func $set_flags_inc (param $a i32) (param $r i32)
    (global.set $saved_cf (call $get_cf))  ;; INC preserves CF
    (global.set $flag_op (i32.const 4)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (i32.const 1)) (global.set $flag_res (local.get $r)))
  (func $set_flags_dec (param $a i32) (param $r i32)
    (global.set $saved_cf (call $get_cf))  ;; DEC preserves CF
    (global.set $flag_op (i32.const 5)) (global.set $flag_sign_shift (i32.const 31))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (i32.const 1)) (global.set $flag_res (local.get $r)))

  (func $get_zf (result i32) (i32.eqz (global.get $flag_res)))
  (func $get_sf (result i32) (i32.and (i32.shr_u (global.get $flag_res) (global.get $flag_sign_shift)) (i32.const 1)))
  (func $get_cf (result i32)
    (if (result i32) (i32.eq (global.get $flag_op) (i32.const 1))
      (then (i32.lt_u (global.get $flag_res) (global.get $flag_a)))
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 2))
      (then (i32.lt_u (global.get $flag_a) (global.get $flag_b)))
    (else (if (result i32) (i32.or (i32.eq (global.get $flag_op) (i32.const 4))
                                   (i32.eq (global.get $flag_op) (i32.const 5)))
      (then (global.get $saved_cf))  ;; INC/DEC preserve CF
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 6))
      (then (global.get $flag_b))  ;; MUL/IMUL: flag_b stores CF/OF
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 7))
      (then (global.get $flag_b))  ;; Shift: flag_b stores last bit shifted out
    (else (if (result i32) (i32.eq (global.get $flag_op) (i32.const 8))
      (then (global.get $flag_a))  ;; Raw mode: CF stored in flag_a
    (else (i32.const 0))))))))))))))
  (func $get_of (result i32)
    (local $sa i32) (local $sb i32) (local $sr i32)
    ;; Raw mode: OF stored in flag_b
    (if (i32.eq (global.get $flag_op) (i32.const 8))
      (then (return (global.get $flag_b))))
    ;; MUL/IMUL: OF = CF = flag_b
    (if (i32.eq (global.get $flag_op) (i32.const 6))
      (then (return (global.get $flag_b))))
    (local.set $sa (i32.and (i32.shr_u (global.get $flag_a) (global.get $flag_sign_shift)) (i32.const 1)))
    (local.set $sb (i32.and (i32.shr_u (global.get $flag_b) (global.get $flag_sign_shift)) (i32.const 1)))
    (local.set $sr (i32.and (i32.shr_u (global.get $flag_res) (global.get $flag_sign_shift)) (i32.const 1)))
    (if (result i32) (i32.or (i32.eq (global.get $flag_op) (i32.const 1)) (i32.eq (global.get $flag_op) (i32.const 4)))
      (then (i32.and (i32.eq (local.get $sa) (local.get $sb)) (i32.ne (local.get $sa) (local.get $sr))))
    (else (if (result i32) (i32.or (i32.eq (global.get $flag_op) (i32.const 2)) (i32.eq (global.get $flag_op) (i32.const 5)))
      (then (i32.and (i32.ne (local.get $sa) (local.get $sb)) (i32.eq (local.get $sb) (local.get $sr))))
    (else (i32.const 0))))))

  ;; Evaluate condition code (same encoding as x86 Jcc lower nibble)
  ;; 0=O,1=NO,2=B,3=AE,4=Z,5=NZ,6=BE,7=A,8=S,9=NS,A=P,B=NP,C=L,D=GE,E=LE,F=G
  (func $eval_cc (param $cc i32) (result i32)
    (local $r i32)
    (if (i32.eq (local.get $cc) (i32.const 0x0)) (then (return (call $get_of))))
    (if (i32.eq (local.get $cc) (i32.const 0x1)) (then (return (i32.eqz (call $get_of)))))
    (if (i32.eq (local.get $cc) (i32.const 0x2)) (then (return (call $get_cf))))
    (if (i32.eq (local.get $cc) (i32.const 0x3)) (then (return (i32.eqz (call $get_cf)))))
    (if (i32.eq (local.get $cc) (i32.const 0x4)) (then (return (call $get_zf))))
    (if (i32.eq (local.get $cc) (i32.const 0x5)) (then (return (i32.eqz (call $get_zf)))))
    (if (i32.eq (local.get $cc) (i32.const 0x6)) (then (return (i32.or (call $get_cf) (call $get_zf)))))
    (if (i32.eq (local.get $cc) (i32.const 0x7)) (then (return (i32.and (i32.eqz (call $get_cf)) (i32.eqz (call $get_zf))))))
    (if (i32.eq (local.get $cc) (i32.const 0x8)) (then (return (call $get_sf))))
    (if (i32.eq (local.get $cc) (i32.const 0x9)) (then (return (i32.eqz (call $get_sf)))))
    ;; 0xA=P (parity) — stub as 0
    (if (i32.eq (local.get $cc) (i32.const 0xA)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $cc) (i32.const 0xB)) (then (return (i32.const 1))))
    ;; 0xC=L: SF!=OF
    (if (i32.eq (local.get $cc) (i32.const 0xC)) (then (return (i32.ne (call $get_sf) (call $get_of)))))
    ;; 0xD=GE: SF==OF
    (if (i32.eq (local.get $cc) (i32.const 0xD)) (then (return (i32.eq (call $get_sf) (call $get_of)))))
    ;; 0xE=LE: ZF=1 or SF!=OF
    (if (i32.eq (local.get $cc) (i32.const 0xE)) (then (return (i32.or (call $get_zf) (i32.ne (call $get_sf) (call $get_of))))))
    ;; 0xF=G: ZF=0 and SF==OF
    (i32.and (i32.eqz (call $get_zf)) (i32.eq (call $get_sf) (call $get_of)))
  )

  ;; Build EFLAGS from lazy state (for pushfd)
  (func $build_eflags (result i32)
    (i32.or (i32.or (i32.or
      (i32.shl (call $get_cf) (i32.const 0))
      (i32.const 2))  ;; bit 1 always set
      (i32.or
        (i32.shl (call $get_zf) (i32.const 6))
        (i32.shl (call $get_sf) (i32.const 7))))
      (i32.or
        (i32.shl (global.get $df) (i32.const 10))
        (i32.shl (call $get_of) (i32.const 11))))
  )

  ;; Restore flags from EFLAGS value (for popfd)
  ;; Uses flag_op=8 (raw mode): CF/ZF/SF/OF stored directly in flag globals
  (func $load_eflags (param $f i32)
    (global.set $df (i32.and (i32.shr_u (local.get $f) (i32.const 10)) (i32.const 1)))
    (global.set $flag_op (i32.const 8))  ;; raw flags mode
    ;; Store individual flag bits in globals: CF in flag_a, OF in flag_b, ZF/SF encoded in flag_res
    (global.set $flag_a (i32.and (local.get $f) (i32.const 1)))  ;; CF = bit 0
    (global.set $flag_b (i32.and (i32.shr_u (local.get $f) (i32.const 11)) (i32.const 1)))  ;; OF = bit 11
    ;; flag_res: bit 31 = SF, zero iff ZF. This makes get_zf and get_sf work with flag_sign_shift=31.
    (global.set $flag_sign_shift (i32.const 31))
    (if (i32.and (local.get $f) (i32.const 0x40))  ;; ZF = bit 6
      (then (global.set $flag_res (i32.const 0)))
      (else (if (i32.and (local.get $f) (i32.const 0x80))  ;; SF = bit 7
        (then (global.set $flag_res (i32.const 0x80000000)))
        (else (global.set $flag_res (i32.const 1))))))
  )

  ;; ============================================================
  ;; BLOCK CACHE
  ;; ============================================================
  (func $cache_lookup (param $ga i32) (result i32)
    (local $idx i32)
    (local.set $idx (i32.add (global.get $CACHE_INDEX)
      (i32.mul (i32.and (i32.shr_u (local.get $ga) (i32.const 2)) (i32.const 0xFFF)) (i32.const 8))))
    (if (result i32) (i32.eq (i32.load (local.get $idx)) (local.get $ga))
      (then (i32.load offset=4 (local.get $idx)))
      (else (i32.const 0))))
  (func $cache_store (param $ga i32) (param $off i32)
    (local $idx i32)
    (local.set $idx (i32.add (global.get $CACHE_INDEX)
      (i32.mul (i32.and (i32.shr_u (local.get $ga) (i32.const 2)) (i32.const 0xFFF)) (i32.const 8))))
    (i32.store (local.get $idx) (local.get $ga))
    (i32.store offset=4 (local.get $idx) (local.get $off)))
  (func $clear_cache
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (i32.const 4096)))
      (i32.store (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0))
      (i32.store offset=4 (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $s))))
  (func $invalidate_page (param $ga i32)
    (local $page i32) (local $i i32) (local $idx i32)
    (local.set $page (i32.and (local.get $ga) (i32.const 0xFFFFF000)))
    (local.set $i (i32.const 0))
    (block $d (loop $s
      (br_if $d (i32.ge_u (local.get $i) (i32.const 4096)))
      (local.set $idx (i32.add (global.get $CACHE_INDEX) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.and (i32.load (local.get $idx)) (i32.const 0xFFFFF000)) (local.get $page))
        (then (i32.store (local.get $idx) (i32.const 0)) (i32.store offset=4 (local.get $idx) (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $s))))

  ;; Thread emit helpers
  (func $te (param $fn i32) (param $op i32)
    (i32.store (global.get $thread_alloc) (local.get $fn))
    (i32.store offset=4 (global.get $thread_alloc) (local.get $op))
    (global.set $thread_alloc (i32.add (global.get $thread_alloc) (i32.const 8))))
  (func $te_raw (param $v i32)
    (i32.store (global.get $thread_alloc) (local.get $v))
    (global.set $thread_alloc (i32.add (global.get $thread_alloc) (i32.const 4))))

  ;; ============================================================
  ;; FORTH INNER INTERPRETER
  ;; ============================================================
  (func $next
    (local $fn i32) (local $op i32)
    (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
    (if (i32.le_s (global.get $steps) (i32.const 0)) (then (return)))
    (local.set $fn (i32.load (global.get $ip)))
    (local.set $op (i32.load offset=4 (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 8)))
    (call_indirect (type $handler_t) (local.get $op) (local.get $fn)))

  ;; Read next thread i32 and advance $ip
  (func $read_thread_word (result i32)
    (local $v i32)
    (local.set $v (i32.load (global.get $ip)))
    (global.set $ip (i32.add (global.get $ip) (i32.const 4)))
    (local.get $v))

  ;; ============================================================
  ;; ALU HELPER — performs operation by index
  ;; ============================================================
  ;; op: 0=ADD,1=OR,2=ADC,3=SBB,4=AND,5=SUB,6=XOR,7=CMP
  (func $do_alu32 (param $op i32) (param $a i32) (param $b i32) (result i32)
    (local $r i32) (local $cf_in i32) (local $b_eff i32)
    (if (i32.eq (local.get $op) (i32.const 0)) ;; ADD
      (then
        (local.set $r (i32.add (local.get $a) (local.get $b)))
        (call $set_flags_add (local.get $a) (local.get $b) (local.get $r))
        (return (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 1)) ;; OR
      (then
        (local.set $r (i32.or (local.get $a) (local.get $b)))
        (call $set_flags_logic (local.get $r))
        (return (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 2)) ;; ADC: r = a + b + cf_in
      (then
        (local.set $cf_in (call $get_cf))
        (local.set $b_eff (i32.add (local.get $b) (local.get $cf_in)))
        (local.set $r (i32.add (local.get $a) (local.get $b_eff)))
        ;; Set flags as ADD(a, b_eff) for OF/ZF/SF
        (call $set_flags_add (local.get $a) (local.get $b_eff) (local.get $r))
        ;; Fix CF: if b+cf_in wrapped (b_eff < b), carry is always 1
        ;; Use raw mode to avoid clobbering flag_res (which holds ZF/SF)
        (if (i32.lt_u (local.get $b_eff) (local.get $b))
          (then (global.set $flag_op (i32.const 8))
                (global.set $flag_a (i32.const 1))
                (global.set $flag_b (i32.const 0))))
        (return (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 3)) ;; SBB: r = a - b - cf_in
      (then
        (local.set $cf_in (call $get_cf))
        (local.set $b_eff (i32.add (local.get $b) (local.get $cf_in)))
        (local.set $r (i32.sub (local.get $a) (local.get $b_eff)))
        ;; Set flags as SUB(a, b_eff) for OF/ZF/SF
        (call $set_flags_sub (local.get $a) (local.get $b_eff) (local.get $r))
        ;; Fix CF: if b+cf_in wrapped, borrow is always 1
        (if (i32.lt_u (local.get $b_eff) (local.get $b))
          (then (global.set $flag_a (i32.const 0))
                (global.set $flag_b (i32.const 1))))
        (return (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 4)) ;; AND
      (then
        (local.set $r (i32.and (local.get $a) (local.get $b)))
        (call $set_flags_logic (local.get $r))
        (return (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 5)) ;; SUB
      (then
        (local.set $r (i32.sub (local.get $a) (local.get $b)))
        (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
        (return (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 6)) ;; XOR
      (then
        (local.set $r (i32.xor (local.get $a) (local.get $b)))
        (call $set_flags_logic (local.get $r))
        (return (local.get $r))))
    ;; 7 = CMP (same as SUB but don't return result to be stored)
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    (local.get $a) ;; return original (CMP doesn't modify dst)
  )

  ;; Shift/rotate helper
  ;; type: 0=ROL,1=ROR,2=RCL,3=RCR,4=SHL,5=SHR,6=SAL(=SHL),7=SAR
  (func $do_shift32 (param $type i32) (param $val i32) (param $count i32) (result i32)
    (local $r i32) (local $cf i32)
    (local.set $count (i32.and (local.get $count) (i32.const 31)))
    (if (i32.eqz (local.get $count)) (then (return (local.get $val))))
    (if (i32.eq (local.get $type) (i32.const 4)) ;; SHL
      (then
        (local.set $r (i32.shl (local.get $val) (local.get $count)))
        ;; CF = bit (32 - count) of original value = last bit shifted out
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (i32.const 32) (local.get $count))) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 5)) ;; SHR
      (then
        (local.set $r (i32.shr_u (local.get $val) (local.get $count)))
        ;; CF = bit (count - 1) of original value
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 7)) ;; SAR
      (then
        (local.set $r (i32.shr_s (local.get $val) (local.get $count)))
        ;; CF = bit (count - 1) of original value
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 0)) ;; ROL — CF = bit 0 of result
      (then
        (local.set $r (i32.or
          (i32.shl (local.get $val) (local.get $count))
          (i32.shr_u (local.get $val) (i32.sub (i32.const 32) (local.get $count)))))
        (call $set_flags_shift (local.get $r) (i32.and (local.get $r) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 1)) ;; ROR — CF = bit 31 of result
      (then
        (local.set $r (i32.or
          (i32.shr_u (local.get $val) (local.get $count))
          (i32.shl (local.get $val) (i32.sub (i32.const 32) (local.get $count)))))
        (call $set_flags_shift (local.get $r) (i32.shr_u (local.get $r) (i32.const 31)))
        (return (local.get $r))))
    ;; RCL: rotate left through carry (33-bit rotation)
    (if (i32.eq (local.get $type) (i32.const 2))
      (then
        (local.set $cf (call $get_cf))
        (block $done (loop $lp
          (br_if $done (i32.eqz (local.get $count)))
          (local.set $r (i32.or (i32.shl (local.get $val) (i32.const 1)) (local.get $cf)))
          (local.set $cf (i32.shr_u (local.get $val) (i32.const 31)))
          (local.set $val (local.get $r))
          (local.set $count (i32.sub (local.get $count) (i32.const 1)))
          (br $lp)))
        (call $set_flags_shift (local.get $val) (local.get $cf))
        (return (local.get $val))))
    ;; RCR: rotate right through carry (33-bit rotation)
    (if (i32.eq (local.get $type) (i32.const 3))
      (then
        (local.set $cf (call $get_cf))
        (block $done (loop $lp
          (br_if $done (i32.eqz (local.get $count)))
          (local.set $r (i32.or (i32.shr_u (local.get $val) (i32.const 1)) (i32.shl (local.get $cf) (i32.const 31))))
          (local.set $cf (i32.and (local.get $val) (i32.const 1)))
          (local.set $val (local.get $r))
          (local.set $count (i32.sub (local.get $count) (i32.const 1)))
          (br $lp)))
        (call $set_flags_shift (local.get $val) (local.get $cf))
        (return (local.get $val))))
    ;; SAL = SHL
    (if (i32.eq (local.get $type) (i32.const 6))
      (then
        (local.set $r (i32.shl (local.get $val) (local.get $count)))
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (i32.const 32) (local.get $count))) (i32.const 1)))
        (return (local.get $r))))
    ;; Fallback
    (local.get $val)
  )

  ;; 8-bit shift: mask to 8 bits, shift, mask result
  (func $do_shift8 (param $type i32) (param $val i32) (param $count i32) (result i32)
    (local $r i32) (local $cf i32)
    (local.set $val (i32.and (local.get $val) (i32.const 0xFF)))
    (local.set $count (i32.and (local.get $count) (i32.const 31)))
    (if (i32.eqz (local.get $count)) (then (return (local.get $val))))
    (if (i32.eq (local.get $type) (i32.const 4)) ;; SHL
      (then
        (local.set $r (i32.shl (local.get $val) (local.get $count)))
        (call $set_flags_shift (i32.and (local.get $r) (i32.const 0xFF))
          (i32.and (i32.shr_u (local.get $val) (i32.sub (i32.const 8) (local.get $count))) (i32.const 1)))
        (return (i32.and (local.get $r) (i32.const 0xFF)))))
    (if (i32.eq (local.get $type) (i32.const 5)) ;; SHR
      (then
        (local.set $r (i32.shr_u (local.get $val) (local.get $count)))
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 7)) ;; SAR
      (then
        ;; Sign-extend from bit 7, then shift
        (if (i32.and (local.get $val) (i32.const 0x80))
          (then (local.set $val (i32.or (local.get $val) (i32.const 0xFFFFFF00)))))
        (local.set $r (i32.and (i32.shr_s (local.get $val) (local.get $count)) (i32.const 0xFF)))
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 0)) ;; ROL
      (then
        (local.set $count (i32.rem_u (local.get $count) (i32.const 8)))
        (if (i32.eqz (local.get $count)) (then (return (local.get $val))))
        (local.set $r (i32.and (i32.or
          (i32.shl (local.get $val) (local.get $count))
          (i32.shr_u (local.get $val) (i32.sub (i32.const 8) (local.get $count)))) (i32.const 0xFF)))
        (call $set_flags_shift (local.get $r) (i32.and (local.get $r) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 1)) ;; ROR
      (then
        (local.set $count (i32.rem_u (local.get $count) (i32.const 8)))
        (if (i32.eqz (local.get $count)) (then (return (local.get $val))))
        (local.set $r (i32.and (i32.or
          (i32.shr_u (local.get $val) (local.get $count))
          (i32.shl (local.get $val) (i32.sub (i32.const 8) (local.get $count)))) (i32.const 0xFF)))
        (call $set_flags_shift (local.get $r) (i32.shr_u (local.get $r) (i32.const 7)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 2)) ;; RCL (9-bit rotation)
      (then
        (local.set $cf (call $get_cf))
        (local.set $count (i32.rem_u (local.get $count) (i32.const 9)))
        (block $done (loop $lp
          (br_if $done (i32.eqz (local.get $count)))
          (local.set $r (i32.or (i32.and (i32.shl (local.get $val) (i32.const 1)) (i32.const 0xFF)) (local.get $cf)))
          (local.set $cf (i32.shr_u (local.get $val) (i32.const 7)))
          (local.set $val (local.get $r))
          (local.set $count (i32.sub (local.get $count) (i32.const 1)))
          (br $lp)))
        (call $set_flags_shift (local.get $val) (local.get $cf))
        (return (local.get $val))))
    (if (i32.eq (local.get $type) (i32.const 3)) ;; RCR (9-bit rotation)
      (then
        (local.set $cf (call $get_cf))
        (local.set $count (i32.rem_u (local.get $count) (i32.const 9)))
        (block $done (loop $lp
          (br_if $done (i32.eqz (local.get $count)))
          (local.set $r (i32.or (i32.shr_u (local.get $val) (i32.const 1)) (i32.shl (local.get $cf) (i32.const 7))))
          (local.set $cf (i32.and (local.get $val) (i32.const 1)))
          (local.set $val (local.get $r))
          (local.set $count (i32.sub (local.get $count) (i32.const 1)))
          (br $lp)))
        (call $set_flags_shift (local.get $val) (local.get $cf))
        (return (local.get $val))))
    (if (i32.eq (local.get $type) (i32.const 6)) ;; SAL = SHL
      (then
        (local.set $r (i32.shl (local.get $val) (local.get $count)))
        (call $set_flags_shift (i32.and (local.get $r) (i32.const 0xFF))
          (i32.and (i32.shr_u (local.get $val) (i32.sub (i32.const 8) (local.get $count))) (i32.const 1)))
        (return (i32.and (local.get $r) (i32.const 0xFF)))))
    (local.get $val))

  ;; 16-bit shift: mask to 16 bits, shift, mask result
  (func $do_shift16 (param $type i32) (param $val i32) (param $count i32) (result i32)
    (local $r i32) (local $cf i32)
    (local.set $val (i32.and (local.get $val) (i32.const 0xFFFF)))
    (local.set $count (i32.and (local.get $count) (i32.const 31)))
    (if (i32.eqz (local.get $count)) (then (return (local.get $val))))
    (if (i32.eq (local.get $type) (i32.const 4)) ;; SHL
      (then
        (local.set $r (i32.shl (local.get $val) (local.get $count)))
        (call $set_flags_shift (i32.and (local.get $r) (i32.const 0xFFFF))
          (i32.and (i32.shr_u (local.get $val) (i32.sub (i32.const 16) (local.get $count))) (i32.const 1)))
        (return (i32.and (local.get $r) (i32.const 0xFFFF)))))
    (if (i32.eq (local.get $type) (i32.const 5)) ;; SHR
      (then
        (local.set $r (i32.shr_u (local.get $val) (local.get $count)))
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 7)) ;; SAR
      (then
        (if (i32.and (local.get $val) (i32.const 0x8000))
          (then (local.set $val (i32.or (local.get $val) (i32.const 0xFFFF0000)))))
        (local.set $r (i32.and (i32.shr_s (local.get $val) (local.get $count)) (i32.const 0xFFFF)))
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (local.get $count) (i32.const 1))) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 0)) ;; ROL
      (then
        (local.set $count (i32.rem_u (local.get $count) (i32.const 16)))
        (if (i32.eqz (local.get $count)) (then (return (local.get $val))))
        (local.set $r (i32.and (i32.or
          (i32.shl (local.get $val) (local.get $count))
          (i32.shr_u (local.get $val) (i32.sub (i32.const 16) (local.get $count)))) (i32.const 0xFFFF)))
        (call $set_flags_shift (local.get $r) (i32.and (local.get $r) (i32.const 1)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 1)) ;; ROR
      (then
        (local.set $count (i32.rem_u (local.get $count) (i32.const 16)))
        (if (i32.eqz (local.get $count)) (then (return (local.get $val))))
        (local.set $r (i32.and (i32.or
          (i32.shr_u (local.get $val) (local.get $count))
          (i32.shl (local.get $val) (i32.sub (i32.const 16) (local.get $count)))) (i32.const 0xFFFF)))
        (call $set_flags_shift (local.get $r) (i32.shr_u (local.get $r) (i32.const 15)))
        (return (local.get $r))))
    (if (i32.eq (local.get $type) (i32.const 2)) ;; RCL (17-bit)
      (then
        (local.set $cf (call $get_cf))
        (local.set $count (i32.rem_u (local.get $count) (i32.const 17)))
        (block $done (loop $lp
          (br_if $done (i32.eqz (local.get $count)))
          (local.set $r (i32.or (i32.and (i32.shl (local.get $val) (i32.const 1)) (i32.const 0xFFFF)) (local.get $cf)))
          (local.set $cf (i32.shr_u (local.get $val) (i32.const 15)))
          (local.set $val (local.get $r))
          (local.set $count (i32.sub (local.get $count) (i32.const 1)))
          (br $lp)))
        (call $set_flags_shift (local.get $val) (local.get $cf))
        (return (local.get $val))))
    (if (i32.eq (local.get $type) (i32.const 3)) ;; RCR (17-bit)
      (then
        (local.set $cf (call $get_cf))
        (local.set $count (i32.rem_u (local.get $count) (i32.const 17)))
        (block $done (loop $lp
          (br_if $done (i32.eqz (local.get $count)))
          (local.set $r (i32.or (i32.shr_u (local.get $val) (i32.const 1)) (i32.shl (local.get $cf) (i32.const 15))))
          (local.set $cf (i32.and (local.get $val) (i32.const 1)))
          (local.set $val (local.get $r))
          (local.set $count (i32.sub (local.get $count) (i32.const 1)))
          (br $lp)))
        (call $set_flags_shift (local.get $val) (local.get $cf))
        (return (local.get $val))))
    (if (i32.eq (local.get $type) (i32.const 6)) ;; SAL = SHL
      (then
        (local.set $r (i32.shl (local.get $val) (local.get $count)))
        (call $set_flags_shift (i32.and (local.get $r) (i32.const 0xFFFF))
          (i32.and (i32.shr_u (local.get $val) (i32.sub (i32.const 16) (local.get $count))) (i32.const 1)))
        (return (i32.and (local.get $r) (i32.const 0xFFFF)))))
    (local.get $val))

  ;; ============================================================
  ;; THREAD HANDLERS
  ;; ============================================================

  ;; 0: nop
  (func $th_nop (param $op i32) (call $next))
  ;; 1: skip next word
  (func $th_next_word (param $op i32) (drop (call $read_thread_word)) (call $next))

  ;; --- Register-Immediate (operand=reg, imm32 in next word) ---
  (func $th_mov_r_i32 (param $op i32) (call $set_reg (local.get $op) (call $read_thread_word)) (call $next))
  (func $th_add_r_i32 (param $op i32)
    (local $old i32) (local $imm i32) (local $r i32)
    (local.set $old (call $get_reg (local.get $op))) (local.set $imm (call $read_thread_word))
    (local.set $r (i32.add (local.get $old) (local.get $imm)))
    (call $set_reg (local.get $op) (local.get $r))
    (call $set_flags_add (local.get $old) (local.get $imm) (local.get $r)) (call $next))
  (func $th_or_r_i32 (param $op i32)
    (local $r i32) (local.set $r (i32.or (call $get_reg (local.get $op)) (call $read_thread_word)))
    (call $set_reg (local.get $op) (local.get $r)) (call $set_flags_logic (local.get $r)) (call $next))
  (func $th_adc_r_i32 (param $op i32)
    (local $old i32) (local $imm i32) (local $r i32) (local $b_eff i32)
    (local.set $old (call $get_reg (local.get $op))) (local.set $imm (call $read_thread_word))
    (local.set $b_eff (i32.add (local.get $imm) (call $get_cf)))
    (local.set $r (i32.add (local.get $old) (local.get $b_eff)))
    (call $set_reg (local.get $op) (local.get $r))
    (call $set_flags_add (local.get $old) (local.get $b_eff) (local.get $r))
    (if (i32.lt_u (local.get $b_eff) (local.get $imm))
      (then (global.set $flag_a (i32.const 0xFFFFFFFF))
            (global.set $flag_res (i32.const 0))))
    (call $next))
  (func $th_sbb_r_i32 (param $op i32)
    (local $old i32) (local $imm i32) (local $r i32) (local $b_eff i32)
    (local.set $old (call $get_reg (local.get $op))) (local.set $imm (call $read_thread_word))
    (local.set $b_eff (i32.add (local.get $imm) (call $get_cf)))
    (local.set $r (i32.sub (local.get $old) (local.get $b_eff)))
    (call $set_reg (local.get $op) (local.get $r))
    (call $set_flags_sub (local.get $old) (local.get $b_eff) (local.get $r))
    (if (i32.lt_u (local.get $b_eff) (local.get $imm))
      (then (global.set $flag_a (i32.const 0))
            (global.set $flag_b (i32.const 1))))
    (call $next))
  (func $th_and_r_i32 (param $op i32)
    (local $r i32) (local.set $r (i32.and (call $get_reg (local.get $op)) (call $read_thread_word)))
    (call $set_reg (local.get $op) (local.get $r)) (call $set_flags_logic (local.get $r)) (call $next))
  (func $th_sub_r_i32 (param $op i32)
    (local $old i32) (local $imm i32) (local $r i32)
    (local.set $old (call $get_reg (local.get $op))) (local.set $imm (call $read_thread_word))
    (local.set $r (i32.sub (local.get $old) (local.get $imm)))
    (call $set_reg (local.get $op) (local.get $r))
    (call $set_flags_sub (local.get $old) (local.get $imm) (local.get $r)) (call $next))
  (func $th_xor_r_i32 (param $op i32)
    (local $r i32) (local.set $r (i32.xor (call $get_reg (local.get $op)) (call $read_thread_word)))
    (call $set_reg (local.get $op) (local.get $r)) (call $set_flags_logic (local.get $r)) (call $next))
  (func $th_cmp_r_i32 (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (call $get_reg (local.get $op))) (local.set $b (call $read_thread_word))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b))) (call $next))

  ;; --- Register-Register (operand = dst<<4 | src) ---
  (func $th_mov_r_r (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (i32.and (local.get $op) (i32.const 0xF)))) (call $next))
  (func $th_add_r_r (param $op i32)
    (local $d i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $a (call $get_reg (local.get $d))) (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (local.set $r (i32.add (local.get $a) (local.get $b)))
    (call $set_reg (local.get $d) (local.get $r)) (call $set_flags_add (local.get $a) (local.get $b) (local.get $r)) (call $next))
  (func $th_or_r_r (param $op i32)
    (local $d i32) (local $r i32) (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $r (i32.or (call $get_reg (local.get $d)) (call $get_reg (i32.and (local.get $op) (i32.const 0xF)))))
    (call $set_reg (local.get $d) (local.get $r)) (call $set_flags_logic (local.get $r)) (call $next))
  (func $th_adc_r_r (param $op i32)
    (local $d i32) (local $a i32) (local $b i32) (local $r i32) (local $b_eff i32)
    (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $a (call $get_reg (local.get $d))) (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (local.set $b_eff (i32.add (local.get $b) (call $get_cf)))
    (local.set $r (i32.add (local.get $a) (local.get $b_eff)))
    (call $set_reg (local.get $d) (local.get $r))
    (call $set_flags_add (local.get $a) (local.get $b_eff) (local.get $r))
    (if (i32.lt_u (local.get $b_eff) (local.get $b))
      (then (global.set $flag_a (i32.const 0xFFFFFFFF))
            (global.set $flag_res (i32.const 0))))
    (call $next))
  (func $th_sbb_r_r (param $op i32)
    (local $d i32) (local $a i32) (local $b i32) (local $r i32) (local $b_eff i32)
    (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $a (call $get_reg (local.get $d))) (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (local.set $b_eff (i32.add (local.get $b) (call $get_cf)))
    (local.set $r (i32.sub (local.get $a) (local.get $b_eff)))
    (call $set_reg (local.get $d) (local.get $r))
    (call $set_flags_sub (local.get $a) (local.get $b_eff) (local.get $r))
    (if (i32.lt_u (local.get $b_eff) (local.get $b))
      (then (global.set $flag_a (i32.const 0))
            (global.set $flag_b (i32.const 1))))
    (call $next))
  (func $th_and_r_r (param $op i32)
    (local $d i32) (local $r i32) (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $r (i32.and (call $get_reg (local.get $d)) (call $get_reg (i32.and (local.get $op) (i32.const 0xF)))))
    (call $set_reg (local.get $d) (local.get $r)) (call $set_flags_logic (local.get $r)) (call $next))
  (func $th_sub_r_r (param $op i32)
    (local $d i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $a (call $get_reg (local.get $d))) (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (local.set $r (i32.sub (local.get $a) (local.get $b)))
    (call $set_reg (local.get $d) (local.get $r)) (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r)) (call $next))
  (func $th_xor_r_r (param $op i32)
    (local $d i32) (local $r i32) (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $r (i32.xor (call $get_reg (local.get $d)) (call $get_reg (i32.and (local.get $op) (i32.const 0xF)))))
    (call $set_reg (local.get $d) (local.get $r)) (call $set_flags_logic (local.get $r)) (call $next))
  (func $th_cmp_r_r (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (call $get_reg (i32.shr_u (local.get $op) (i32.const 4))))
    (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b))) (call $next))

  ;; Helper: read address from thread word, but if sentinel (0xEADEAD), use ea_temp
  (func $read_addr (result i32)
    (local $a i32) (local.set $a (call $read_thread_word))
    (if (result i32) (i32.eq (local.get $a) (i32.const 0xEADEAD))
      (then (global.get $ea_temp))
      (else (local.get $a))))

  ;; --- Load/Store absolute (operand=reg, guest_addr in next word or ea_temp) ---
  (func $th_load32 (param $op i32) (call $set_reg (local.get $op) (call $gl32 (call $read_addr))) (call $next))
  (func $th_store32 (param $op i32) (call $gs32 (call $read_addr) (call $get_reg (local.get $op))) (call $next))
  (func $th_load16 (param $op i32) (call $set_reg16 (local.get $op) (call $gl16 (call $read_addr))) (call $next))
  (func $th_store16 (param $op i32) (call $gs16 (call $read_addr) (call $get_reg16 (local.get $op))) (call $next))
  (func $th_load8 (param $op i32) (call $set_reg8 (local.get $op) (call $gl8 (call $read_addr))) (call $next))
  (func $th_store8 (param $op i32) (call $gs8 (call $read_addr) (call $get_reg8 (local.get $op))) (call $next))

  ;; --- Load/Store reg+offset (operand=dst<<4|base, disp in next word) ---
  (func $th_load32_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word))))
    (call $next))
  (func $th_store32_ro (param $op i32)
    (local $disp i32) (local.set $disp (call $read_thread_word))
    (call $gs32 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (local.get $disp))
      (call $get_reg (i32.shr_u (local.get $op) (i32.const 4))))
    (call $next))
  (func $th_load8_ro (param $op i32)
    (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word))))
    (call $next))
  (func $th_store8_ro (param $op i32)
    (local $disp i32) (local.set $disp (call $read_thread_word))
    (call $gs8 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (local.get $disp))
      (call $get_reg8 (i32.shr_u (local.get $op) (i32.const 4))))
    (call $next))
  (func $th_load16_ro (param $op i32)
    (call $set_reg16 (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl16 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word))))
    (call $next))
  (func $th_store16_ro (param $op i32)
    (local $disp i32) (local.set $disp (call $read_thread_word))
    (call $gs16 (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (local.get $disp))
      (call $get_reg16 (i32.shr_u (local.get $op) (i32.const 4))))
    (call $next))

  ;; --- Stack ---
  (func $th_push_r (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $get_reg (local.get $op))) (call $next))
  (func $th_pop_r (param $op i32)
    (call $set_reg (local.get $op) (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (call $next))
  (func $th_push_i32 (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $read_thread_word)) (call $next))
  (func $th_pushad (param $op i32)
    (local $tmp i32) (local.set $tmp (global.get $esp))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 32)))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (global.get $eax))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (global.get $ecx))
    (call $gs32 (i32.add (global.get $esp) (i32.const 20)) (global.get $edx))
    (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (global.get $ebx))
    (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $tmp))
    (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (global.get $ebp))
    (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (global.get $esi))
    (call $gs32 (global.get $esp) (global.get $edi))
    (call $next))
  (func $th_popad (param $op i32)
    (global.set $edi (call $gl32 (global.get $esp)))
    (global.set $esi (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (global.set $ebp (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    ;; skip ESP at +12
    (global.set $ebx (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (global.set $edx (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (global.set $ecx (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
    (call $next))
  (func $th_pushfd (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $build_eflags)) (call $next))
  (func $th_popfd (param $op i32)
    (call $load_eflags (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (call $next))

  ;; --- Control flow ---
  (func $th_call_rel (param $op i32)
    (local $target i32) (local.set $target (call $read_thread_word))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $op))
    (global.set $eip (local.get $target)))
  (func $th_call_ind (param $op i32)
    (local $mem_addr i32) (local $target i32)
    (local.set $mem_addr (call $read_addr))
    (local.set $target (call $gl32 (local.get $mem_addr)))
    ;; Check thunk zone (guest-space bounds)
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $op))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        ;; If dispatch redirected (steps=0), EIP is already set (e.g. DispatchMessageA→WndProc)
        (if (global.get $steps) (then (global.set $eip (local.get $op))))
        (return)))
    ;; Regular indirect call
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $op))
    (global.set $eip (local.get $target)))
  (func $th_ret (param $op i32)
    (global.set $eip (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))))
  (func $th_ret_imm (param $op i32)
    (global.set $eip (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.add (i32.const 4) (local.get $op)))))
  (func $th_jmp (param $op i32) (global.set $eip (call $read_thread_word)))
  (func $th_jcc (param $op i32)
    (local $fall i32) (local $target i32)
    (local.set $fall (call $read_thread_word)) (local.set $target (call $read_thread_word))
    (if (call $eval_cc (local.get $op))
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $fall)))))
  (func $th_block_end (param $op i32) (global.set $eip (local.get $op)))
  (func $th_loop (param $op i32)
    ;; operand: 0=LOOP, 1=LOOPE, 2=LOOPNE
    (local $target i32) (local $fall i32) (local $take i32)
    (local.set $target (call $read_thread_word)) (local.set $fall (call $read_thread_word))
    (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
    (local.set $take (i32.ne (global.get $ecx) (i32.const 0)))
    (if (i32.eq (local.get $op) (i32.const 1)) ;; LOOPE
      (then (local.set $take (i32.and (local.get $take) (call $get_zf)))))
    (if (i32.eq (local.get $op) (i32.const 2)) ;; LOOPNE
      (then (local.set $take (i32.and (local.get $take) (i32.eqz (call $get_zf))))))
    (if (local.get $take)
      (then (global.set $eip (local.get $target)))
      (else (global.set $eip (local.get $fall)))))

  ;; --- ALU memory ---
  ;; 47: [addr] OP= reg  (operand=alu_op<<4|reg, addr in next word)
  (func $th_alu_m32_r (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $alu (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl32 (local.get $addr)) (call $get_reg (local.get $reg))))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (call $next))
  ;; 48: reg OP= [addr]
  (func $th_alu_r_m32 (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $alu (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $get_reg (local.get $reg)) (call $gl32 (local.get $addr))))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg (local.get $reg) (local.get $val))))
    (call $next))
  ;; 49: [addr] OP= reg (byte)
  (func $th_alu_m8_r (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $addr (call $read_addr))
    (local.set $alu (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $a (call $gl8 (local.get $addr))) (local.set $b (call $get_reg8 (local.get $reg)))
    (local.set $r (call $do_alu32 (local.get $alu) (local.get $a) (local.get $b)))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $r))))
    (call $next))
  ;; 50: reg OP= [addr] (byte)
  (func $th_alu_r_m8 (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $a i32) (local $b i32) (local $r i32)
    (local.set $addr (call $read_addr))
    (local.set $alu (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $a (call $get_reg8 (local.get $reg))) (local.set $b (call $gl8 (local.get $addr)))
    (local.set $r (call $do_alu32 (local.get $alu) (local.get $a) (local.get $b)))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg8 (local.get $reg) (local.get $r))))
    (call $next))
  ;; 51: [addr] OP= imm32  (operand=alu_op, addr+imm in next words)
  (func $th_alu_m32_i32 (param $op i32)
    (local $addr i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $read_addr)) (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $op) (call $gl32 (local.get $addr)) (local.get $imm)))
    (if (i32.ne (local.get $op) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (call $next))
  ;; 52: [addr] OP= imm8  (operand=alu_op, addr+imm in next words)
  (func $th_alu_m8_i8 (param $op i32)
    (local $addr i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $read_addr)) (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $op) (call $gl8 (local.get $addr)) (local.get $imm)))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $op) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (call $next))

  ;; --- Shifts ---
  ;; 53: shift reg (operand = reg | shift_type<<8 | count<<16, count=0xFF means CL)
  (func $th_shift_r (param $op i32)
    (local $reg i32) (local $type i32) (local $count i32)
    (local.set $reg (i32.and (local.get $op) (i32.const 0xFF)))
    (local.set $type (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.eq (local.get $count) (i32.const 0xFF))
      (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (call $set_reg (local.get $reg) (call $do_shift32 (local.get $type) (call $get_reg (local.get $reg)) (local.get $count)))
    (call $next))
  ;; 54: shift [addr] (operand = shift_type<<8 | count<<16, addr in next word)
  (func $th_shift_m32 (param $op i32)
    (local $addr i32) (local $type i32) (local $count i32)
    (local.set $addr (call $read_addr))
    (local.set $type (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.eq (local.get $count) (i32.const 0xFF))
      (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (call $gs32 (local.get $addr) (call $do_shift32 (local.get $type) (call $gl32 (local.get $addr)) (local.get $count)))
    (call $next))

  ;; Set CF=OF for MUL/IMUL (1 if upper half non-zero)
  (func $set_flags_mul (param $upper_nonzero i32)
    (global.set $flag_op (i32.const 6))
    (global.set $flag_b (local.get $upper_nonzero))  ;; CF=OF=flag_b for op=6
    (global.set $flag_res (global.get $eax)))         ;; ZF/SF from low result

  ;; 191: shift reg8 (operand = reg8_id | shift_type<<8 | count<<16, 0xFF=CL)
  (func $th_shift_r8 (param $op i32)
    (local $reg i32) (local $type i32) (local $count i32)
    (local.set $reg (i32.and (local.get $op) (i32.const 0xFF)))
    (local.set $type (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.eq (local.get $count) (i32.const 0xFF))
      (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (call $set_reg8 (local.get $reg) (call $do_shift8 (local.get $type) (call $get_reg8 (local.get $reg)) (local.get $count)))
    (global.set $flag_sign_shift (i32.const 7))
    (call $next))
  ;; 192: shift [addr] byte (operand = shift_type<<8 | count<<16, addr in next word)
  (func $th_shift_m8 (param $op i32)
    (local $addr i32) (local $type i32) (local $count i32)
    (local.set $addr (call $read_addr))
    (local.set $type (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.eq (local.get $count) (i32.const 0xFF))
      (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (call $gs8 (local.get $addr) (call $do_shift8 (local.get $type) (call $gl8 (local.get $addr)) (local.get $count)))
    (global.set $flag_sign_shift (i32.const 7))
    (call $next))
  ;; 193: shift reg16 (operand = reg | shift_type<<8 | count<<16)
  (func $th_shift_r16 (param $op i32)
    (local $reg i32) (local $type i32) (local $count i32) (local $r i32)
    (local.set $reg (i32.and (local.get $op) (i32.const 0xFF)))
    (local.set $type (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.eq (local.get $count) (i32.const 0xFF))
      (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (local.set $r (call $do_shift16 (local.get $type) (call $get_reg (local.get $reg)) (local.get $count)))
    (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (local.get $r)))
    (global.set $flag_sign_shift (i32.const 15))
    (call $next))
  ;; 194: shift [addr] word (operand = shift_type<<8 | count<<16, addr in next word)
  (func $th_shift_m16 (param $op i32)
    (local $addr i32) (local $type i32) (local $count i32)
    (local.set $addr (call $read_addr))
    (local.set $type (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xFF)))
    (local.set $count (i32.and (i32.shr_u (local.get $op) (i32.const 16)) (i32.const 0xFF)))
    (if (i32.eq (local.get $count) (i32.const 0xFF))
      (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (call $gs16 (local.get $addr) (call $do_shift16 (local.get $type) (call $gl16 (local.get $addr)) (local.get $count)))
    (global.set $flag_sign_shift (i32.const 15))
    (call $next))
  ;; 195: CMPXCHG8B [addr] — compare EDX:EAX with 8 bytes at [addr]
  (func $th_cmpxchg8b (param $op i32)
    (local $addr i32) (local $lo i32) (local $hi i32)
    (local.set $addr (call $read_addr))
    (local.set $lo (call $gl32 (local.get $addr)))
    (local.set $hi (call $gl32 (i32.add (local.get $addr) (i32.const 4))))
    (if (i32.and (i32.eq (global.get $eax) (local.get $lo)) (i32.eq (global.get $edx) (local.get $hi)))
      (then
        ;; Equal: ZF=1, store ECX:EBX at [addr]
        (call $set_flags_logic (i32.const 0)) ;; ZF=1
        (call $gs32 (local.get $addr) (global.get $ebx))
        (call $gs32 (i32.add (local.get $addr) (i32.const 4)) (global.get $ecx)))
      (else
        ;; Not equal: ZF=0, load [addr] into EDX:EAX
        (call $set_flags_logic (i32.const 1)) ;; ZF=0
        (global.set $eax (local.get $lo))
        (global.set $edx (local.get $hi))))
    (call $next))

  ;; --- Multiply / Divide ---
  (func $th_mul32 (param $op i32)
    (local $val i64)
    (local.set $val (i64.mul (i64.extend_i32_u (global.get $eax)) (i64.extend_i32_u (call $get_reg (local.get $op)))))
    (global.set $eax (i32.wrap_i64 (local.get $val)))
    (global.set $edx (i32.wrap_i64 (i64.shr_u (local.get $val) (i64.const 32))))
    (call $set_flags_mul (i32.ne (global.get $edx) (i32.const 0)))
    (call $next))
  (func $th_imul32 (param $op i32)
    (local $val i64)
    (local.set $val (i64.mul (i64.extend_i32_s (global.get $eax)) (i64.extend_i32_s (call $get_reg (local.get $op)))))
    (global.set $eax (i32.wrap_i64 (local.get $val)))
    (global.set $edx (i32.wrap_i64 (i64.shr_s (local.get $val) (i64.const 32))))
    ;; CF=OF=1 if result doesn't fit in 32-bit signed (edx != sign-extend of eax)
    (call $set_flags_mul (i32.ne (global.get $edx) (i32.shr_s (global.get $eax) (i32.const 31))))
    (call $next))
  (func $th_div32 (param $op i32)
    (local $divisor i64) (local $dividend i64)
    (local.set $divisor (i64.extend_i32_u (call $get_reg (local.get $op))))
    (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
    (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 0)) (return)))
    (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $dividend) (local.get $divisor))))
    (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor))))
    (call $next))
  (func $th_idiv32 (param $op i32)
    (local $divisor i64) (local $dividend i64)
    (local.set $divisor (i64.extend_i32_s (call $get_reg (local.get $op))))
    (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
    (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 1)) (return)))
    ;; Signed overflow: EDX:EAX = 0xFFFFFFFF80000000 / -1 => #DE
    (if (i32.and (i64.eq (local.get $divisor) (i64.const -1))
                 (i64.eq (local.get $dividend) (i64.const 0xFFFFFFFF80000000)))
      (then (call $raise_exception (i32.const 1)) (return)))
    (global.set $eax (i32.wrap_i64 (i64.div_s (local.get $dividend) (local.get $divisor))))
    (global.set $edx (i32.wrap_i64 (i64.rem_s (local.get $dividend) (local.get $divisor))))
    (call $next))
  ;; imul dst, src, imm
  (func $th_imul_r_r_i (param $op i32)
    (local $imm i32)
    (local.set $imm (call $read_thread_word))
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (i32.mul (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (local.get $imm)))
    (call $next))
  ;; mul/imul/div/idiv [addr]
  (func $th_mul_m32 (param $op i32)
    (local $val i64) (local $addr i32) (local.set $addr (call $read_thread_word))
    (local.set $val (i64.mul (i64.extend_i32_u (global.get $eax)) (i64.extend_i32_u (call $gl32 (local.get $addr)))))
    (global.set $eax (i32.wrap_i64 (local.get $val)))
    (global.set $edx (i32.wrap_i64 (i64.shr_u (local.get $val) (i64.const 32))))
    (call $set_flags_mul (i32.ne (global.get $edx) (i32.const 0))) (call $next))
  (func $th_imul_m32 (param $op i32)
    (local $val i64) (local $addr i32) (local.set $addr (call $read_thread_word))
    (local.set $val (i64.mul (i64.extend_i32_s (global.get $eax)) (i64.extend_i32_s (call $gl32 (local.get $addr)))))
    (global.set $eax (i32.wrap_i64 (local.get $val)))
    (global.set $edx (i32.wrap_i64 (i64.shr_s (local.get $val) (i64.const 32))))
    (call $set_flags_mul (i32.ne (global.get $edx) (i32.shr_s (global.get $eax) (i32.const 31)))) (call $next))
  (func $th_div_m32 (param $op i32)
    (local $divisor i64) (local $dividend i64) (local $addr i32) (local.set $addr (call $read_thread_word))
    (local.set $divisor (i64.extend_i32_u (call $gl32 (local.get $addr))))
    (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
    (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 2)) (return)))
    (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $dividend) (local.get $divisor))))
    (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor)))) (call $next))
  (func $th_idiv_m32 (param $op i32)
    (local $divisor i64) (local $dividend i64) (local $addr i32) (local.set $addr (call $read_thread_word))
    (local.set $divisor (i64.extend_i32_s (call $gl32 (local.get $addr))))
    (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
    (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 3)) (return)))
    ;; Signed overflow: EDX:EAX = 0xFFFFFFFF80000000 / -1 => #DE
    (if (i32.and (i64.eq (local.get $divisor) (i64.const -1))
                 (i64.eq (local.get $dividend) (i64.const 0xFFFFFFFF80000000)))
      (then (call $raise_exception (i32.const 3)) (return)))
    (global.set $eax (i32.wrap_i64 (i64.div_s (local.get $dividend) (local.get $divisor))))
    (global.set $edx (i32.wrap_i64 (i64.rem_s (local.get $dividend) (local.get $divisor)))) (call $next))

  ;; --- Unary register ---
  (func $th_inc_r (param $op i32)
    (local $old i32) (local $r i32)
    (local.set $old (call $get_reg (local.get $op)))
    (local.set $r (i32.add (local.get $old) (i32.const 1)))
    (call $set_reg (local.get $op) (local.get $r))
    (call $set_flags_inc (local.get $old) (local.get $r)) (call $next))
  (func $th_dec_r (param $op i32)
    (local $old i32) (local $r i32)
    (local.set $old (call $get_reg (local.get $op)))
    (local.set $r (i32.sub (local.get $old) (i32.const 1)))
    (call $set_reg (local.get $op) (local.get $r))
    (call $set_flags_dec (local.get $old) (local.get $r)) (call $next))
  (func $th_not_r (param $op i32)
    (call $set_reg (local.get $op) (i32.xor (call $get_reg (local.get $op)) (i32.const -1))) (call $next))
  (func $th_neg_r (param $op i32)
    (local $old i32) (local $r i32)
    (local.set $old (call $get_reg (local.get $op)))
    (local.set $r (i32.sub (i32.const 0) (local.get $old)))
    (call $set_reg (local.get $op) (local.get $r))
    (call $set_flags_sub (i32.const 0) (local.get $old) (local.get $r)) (call $next))

  ;; --- Unary memory ---
  ;; 68: operand = unary_type (0=inc,1=dec,2=not,3=neg), addr in next word
  (func $th_unary_m32 (param $op i32)
    (local $addr i32) (local $old i32) (local $r i32)
    (local.set $addr (call $read_addr))
    (local.set $old (call $gl32 (local.get $addr)))
    (if (i32.eq (local.get $op) (i32.const 0))
      (then (local.set $r (i32.add (local.get $old) (i32.const 1)))
            (call $set_flags_inc (local.get $old) (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 1))
      (then (local.set $r (i32.sub (local.get $old) (i32.const 1)))
            (call $set_flags_dec (local.get $old) (local.get $r))))
    (if (i32.eq (local.get $op) (i32.const 2))
      (then (local.set $r (i32.xor (local.get $old) (i32.const -1)))))
    (if (i32.eq (local.get $op) (i32.const 3))
      (then (local.set $r (i32.sub (i32.const 0) (local.get $old)))
            (call $set_flags_sub (i32.const 0) (local.get $old) (local.get $r))))
    (call $gs32 (local.get $addr) (local.get $r)) (call $next))
  (func $th_unary_m8 (param $op i32)
    (local $addr i32) (local $old i32) (local $r i32)
    (local.set $addr (call $read_addr))
    (local.set $old (call $gl8 (local.get $addr)))
    (if (i32.eq (local.get $op) (i32.const 0))
      (then (local.set $r (i32.add (local.get $old) (i32.const 1)))))
    (if (i32.eq (local.get $op) (i32.const 1))
      (then (local.set $r (i32.sub (local.get $old) (i32.const 1)))))
    (if (i32.eq (local.get $op) (i32.const 2))
      (then (local.set $r (i32.xor (local.get $old) (i32.const 0xFF)))))
    (if (i32.eq (local.get $op) (i32.const 3))
      (then (local.set $r (i32.sub (i32.const 0) (local.get $old)))))
    (call $gs8 (local.get $addr) (local.get $r)) (call $next))

  ;; --- LEA ---
  (func $th_lea (param $op i32) (call $set_reg (local.get $op) (call $read_thread_word)) (call $next))

  ;; --- XCHG ---
  (func $th_xchg_r_r (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (call $get_reg (i32.shr_u (local.get $op) (i32.const 4))))
    (local.set $b (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (local.get $b))
    (call $set_reg (i32.and (local.get $op) (i32.const 0xF)) (local.get $a))
    (call $next))
  ;; 196: xchg [addr], reg (op=reg, addr in next word)
  (func $th_xchg_m_r (param $op i32)
    (local $addr i32) (local $tmp i32)
    (local.set $addr (call $read_thread_word))
    (local.set $tmp (call $gl32 (local.get $addr)))
    (call $gs32 (local.get $addr) (call $get_reg (local.get $op)))
    (call $set_reg (local.get $op) (local.get $tmp))
    (call $next))
  ;; 197: xchg [base+disp], reg (op=reg<<4|base, disp in word)
  (func $th_xchg_m_r_ro (param $op i32)
    (local $addr i32) (local $tmp i32)
    (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))
    (local.set $tmp (call $gl32 (local.get $addr)))
    (call $gs32 (local.get $addr) (call $get_reg (i32.shr_u (local.get $op) (i32.const 4))))
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (local.get $tmp))
    (call $next))

  ;; --- TEST ---
  (func $th_test_r_r (param $op i32)
    (call $set_flags_logic (i32.and
      (call $get_reg (i32.shr_u (local.get $op) (i32.const 4)))
      (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))) (call $next))
  (func $th_test_r_i32 (param $op i32)
    (call $set_flags_logic (i32.and (call $get_reg (local.get $op)) (call $read_thread_word))) (call $next))
  (func $th_test_m32_r (param $op i32)
    (call $set_flags_logic (i32.and (call $gl32 (call $read_addr)) (call $get_reg (local.get $op)))) (call $next))
  (func $th_test_m32_i32 (param $op i32)
    (local $addr i32) (local.set $addr (call $read_addr))
    (call $set_flags_logic (i32.and (call $gl32 (local.get $addr)) (call $read_thread_word))) (call $next))

  ;; --- TEST byte ---
  (func $th_test_r8_r8 (param $op i32)
    (call $set_flags_logic (i32.and
      (call $get_reg8 (i32.shr_u (local.get $op) (i32.const 4)))
      (call $get_reg8 (i32.and (local.get $op) (i32.const 0xF))))) (call $next))
  (func $th_test_m8_r (param $op i32)
    (call $set_flags_logic (i32.and (call $gl8 (call $read_addr)) (call $get_reg8 (local.get $op)))) (call $next))
  (func $th_test_m8_r_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))
    (call $set_flags_logic (i32.and (call $gl8 (local.get $addr)) (call $get_reg8 (i32.shr_u (local.get $op) (i32.const 4))))) (call $next))

  ;; --- Byte register-register ALU (op = alu_op<<8 | dst<<4 | src) ---
  (func $th_alu_r8_r8 (param $op i32)
    (local $alu i32) (local $d i32) (local $s i32) (local $a i32) (local $b i32) (local $r i32) (local $cf_in i32)
    (local.set $alu (i32.shr_u (local.get $op) (i32.const 8)))
    (local.set $d (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $s (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $a (call $get_reg8 (local.get $d)))
    (local.set $b (call $get_reg8 (local.get $s)))
    (block $done (block $cmp (block $xor (block $sub (block $and (block $sbb (block $adc (block $or (block $add
      (br_table $add $or $adc $sbb $and $sub $xor $cmp (local.get $alu)))
    ;; 0: ADD (after $add block end)
    (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $d) (local.get $r))
    (call $set_flags_add (local.get $a) (local.get $b) (local.get $r)) (br $done)
    ) ;; 1: OR (after $or block end)
    (local.set $r (i32.or (local.get $a) (local.get $b)))
    (call $set_reg8 (local.get $d) (local.get $r))
    (call $set_flags_logic (local.get $r)) (br $done)
    ) ;; end $adc — ADC case
    (local.set $cf_in (call $get_cf))
    (local.set $r (i32.add (i32.add (local.get $a) (local.get $b)) (local.get $cf_in)))
    (call $set_reg8 (local.get $d) (i32.and (local.get $r) (i32.const 0xFF)))
    (call $set_flags_add (local.get $a) (i32.add (local.get $b) (local.get $cf_in)) (i32.and (local.get $r) (i32.const 0xFF)))
    ;; Fix 8-bit CF: carry if full sum >= 0x100 — use raw mode to preserve flag_res
    (if (i32.ge_u (local.get $r) (i32.const 0x100))
      (then (global.set $flag_op (i32.const 8))
            (global.set $flag_a (i32.const 1))
            (global.set $flag_b (i32.const 0))))
    (br $done)
    ) ;; end $sbb — SBB case
    (local.set $cf_in (call $get_cf))
    (local.set $r (i32.sub (i32.sub (local.get $a) (local.get $b)) (local.get $cf_in)))
    (call $set_reg8 (local.get $d) (i32.and (local.get $r) (i32.const 0xFF)))
    (call $set_flags_sub (local.get $a) (i32.add (local.get $b) (local.get $cf_in)) (i32.and (local.get $r) (i32.const 0xFF)))
    ;; Fix 8-bit CF: borrow if result went negative (bit 8+ set)
    (if (i32.and (local.get $r) (i32.const 0xFFFFFF00))
      (then (global.set $flag_op (i32.const 8))
            (global.set $flag_a (i32.const 1))
            (global.set $flag_b (i32.const 0))))
    (br $done)
    ) ;; end $and — AND case
    (local.set $r (i32.and (local.get $a) (local.get $b)))
    (call $set_reg8 (local.get $d) (local.get $r))
    (call $set_flags_logic (local.get $r)) (br $done)
    ) ;; end $sub — SUB case
    (local.set $r (i32.and (i32.sub (local.get $a) (local.get $b)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $d) (local.get $r))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r)) (br $done)
    ) ;; end $xor — XOR case
    (local.set $r (i32.xor (local.get $a) (local.get $b)))
    (call $set_reg8 (local.get $d) (local.get $r))
    (call $set_flags_logic (local.get $r)) (br $done)
    ) ;; end $cmp — CMP case
    (local.set $r (i32.and (i32.sub (local.get $a) (local.get $b)) (i32.const 0xFF)))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    ) ;; end $done
    (global.set $flag_sign_shift (i32.const 7))
    (call $next))

  ;; --- Byte register-immediate ALU (op = alu_op<<8 | reg, imm in next word) ---
  (func $th_alu_r8_i8 (param $op i32)
    (local $alu i32) (local $reg i32) (local $a i32) (local $b i32) (local $r i32) (local $cf_in i32)
    (local.set $alu (i32.shr_u (local.get $op) (i32.const 8)))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $a (call $get_reg8 (local.get $reg)))
    (local.set $b (i32.and (call $read_thread_word) (i32.const 0xFF)))
    (block $done (block $cmp (block $xor (block $sub (block $and (block $sbb (block $adc (block $or (block $add
      (br_table $add $or $adc $sbb $and $sub $xor $cmp (local.get $alu)))
    ;; 0: ADD
    (local.set $r (i32.and (i32.add (local.get $a) (local.get $b)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $reg) (local.get $r))
    (call $set_flags_add (local.get $a) (local.get $b) (local.get $r)) (br $done)
    )
    (local.set $r (i32.or (local.get $a) (local.get $b)))
    (call $set_reg8 (local.get $reg) (local.get $r))
    (call $set_flags_logic (local.get $r)) (br $done)
    )
    (local.set $cf_in (call $get_cf))
    (local.set $r (i32.add (i32.add (local.get $a) (local.get $b)) (local.get $cf_in)))
    (call $set_reg8 (local.get $reg) (i32.and (local.get $r) (i32.const 0xFF)))
    (call $set_flags_add (local.get $a) (i32.add (local.get $b) (local.get $cf_in)) (i32.and (local.get $r) (i32.const 0xFF)))
    (if (i32.ge_u (local.get $r) (i32.const 0x100))
      (then (global.set $flag_op (i32.const 8))
            (global.set $flag_a (i32.const 1))
            (global.set $flag_b (i32.const 0))))
    (br $done)
    )
    (local.set $cf_in (call $get_cf))
    (local.set $r (i32.sub (i32.sub (local.get $a) (local.get $b)) (local.get $cf_in)))
    (call $set_reg8 (local.get $reg) (i32.and (local.get $r) (i32.const 0xFF)))
    (call $set_flags_sub (local.get $a) (i32.add (local.get $b) (local.get $cf_in)) (i32.and (local.get $r) (i32.const 0xFF)))
    (if (i32.and (local.get $r) (i32.const 0xFFFFFF00))
      (then (global.set $flag_op (i32.const 8))
            (global.set $flag_a (i32.const 1))
            (global.set $flag_b (i32.const 0))))
    (br $done)
    )
    (local.set $r (i32.and (local.get $a) (local.get $b)))
    (call $set_reg8 (local.get $reg) (local.get $r))
    (call $set_flags_logic (local.get $r)) (br $done)
    )
    (local.set $r (i32.and (i32.sub (local.get $a) (local.get $b)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $reg) (local.get $r))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r)) (br $done)
    )
    (local.set $r (i32.xor (local.get $a) (local.get $b)))
    (call $set_reg8 (local.get $reg) (local.get $r))
    (call $set_flags_logic (local.get $r)) (br $done)
    )
    (local.set $r (i32.and (i32.sub (local.get $a) (local.get $b)) (i32.const 0xFF)))
    (call $set_flags_sub (local.get $a) (local.get $b) (local.get $r))
    )
    (global.set $flag_sign_shift (i32.const 7))
    (call $next))

  ;; --- Byte MOV reg8, reg8 (op = dst<<4 | src) ---
  (func $th_mov_r8_r8 (param $op i32)
    (call $set_reg8 (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg8 (i32.and (local.get $op) (i32.const 0xF)))) (call $next))

  ;; --- Byte MOV reg8, imm8 (op = reg, imm in next word) ---
  (func $th_mov_r8_i8 (param $op i32)
    (call $set_reg8 (local.get $op) (i32.and (call $read_thread_word) (i32.const 0xFF))) (call $next))

  ;; --- MOV memory-immediate ---
  (func $th_mov_m32_i32 (param $op i32)
    (local $addr i32) (local.set $addr (call $read_addr))
    (call $gs32 (local.get $addr) (call $read_thread_word)) (call $next))
  (func $th_mov_m8_i8 (param $op i32)
    (call $gs8 (call $read_addr) (local.get $op)) (call $next))

  ;; --- MOVZX / MOVSX ---
  (func $th_movzx8 (param $op i32) (call $set_reg (local.get $op) (call $gl8 (call $read_addr))) (call $next))
  (func $th_movsx8 (param $op i32)
    (local $v i32) (local.set $v (call $gl8 (call $read_addr)))
    (if (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFFFF00)))))
    (call $set_reg (local.get $op) (local.get $v)) (call $next))
  (func $th_movzx16 (param $op i32) (call $set_reg (local.get $op) (call $gl16 (call $read_addr))) (call $next))
  (func $th_movsx16 (param $op i32)
    (local $v i32) (local.set $v (call $gl16 (call $read_addr)))
    (if (i32.ge_u (local.get $v) (i32.const 0x8000))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFF0000)))))
    (call $set_reg (local.get $op) (local.get $v)) (call $next))

  ;; --- String ops ---
  (func $th_movsb (param $op i32)
    (call $gs8 (global.get $edi) (call $gl8 (global.get $esi)))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1)))
            (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 1)))
            (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
    (call $next))
  (func $th_movsd (param $op i32)
    (call $gs32 (global.get $edi) (call $gl32 (global.get $esi)))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4)))
            (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 4)))
            (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
    (call $next))
  (func $th_stosb (param $op i32)
    (call $gs8 (global.get $edi) (i32.and (global.get $eax) (i32.const 0xFF)))
    (if (global.get $df)
      (then (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
      (else (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
    (call $next))
  (func $th_stosd (param $op i32)
    (call $gs32 (global.get $edi) (global.get $eax))
    (if (global.get $df)
      (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
      (else (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
    (call $next))
  (func $th_lodsb (param $op i32)
    (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFFFF00)) (call $gl8 (global.get $esi))))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 1)))))
    (call $next))
  (func $th_lodsd (param $op i32)
    (global.set $eax (call $gl32 (global.get $esi)))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 4)))))
    (call $next))
  ;; REP versions (inline loop)
  (func $th_rep_movsb (param $op i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (call $gs8 (global.get $edi) (call $gl8 (global.get $esi)))
      (if (global.get $df)
        (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1)))
              (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
        (else (global.set $esi (i32.add (global.get $esi) (i32.const 1)))
              (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (br $l))) (call $next))
  (func $th_rep_movsd (param $op i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (call $gs32 (global.get $edi) (call $gl32 (global.get $esi)))
      (if (global.get $df)
        (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4)))
              (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
        (else (global.set $esi (i32.add (global.get $esi) (i32.const 4)))
              (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (br $l))) (call $next))
  (func $th_rep_stosb (param $op i32)
    (local $al i32) (local.set $al (i32.and (global.get $eax) (i32.const 0xFF)))
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (call $gs8 (global.get $edi) (local.get $al))
      (if (global.get $df)
        (then (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
        (else (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (br $l))) (call $next))
  (func $th_rep_stosd (param $op i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (call $gs32 (global.get $edi) (global.get $eax))
      (if (global.get $df)
        (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
        (else (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (br $l))) (call $next))
  (func $th_cmpsb (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (call $gl8 (global.get $esi))) (local.set $b (call $gl8 (global.get $edi)))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1)))
            (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 1)))
            (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
    (call $next))
  (func $th_scasb (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (i32.and (global.get $eax) (i32.const 0xFF)))
    (local.set $b (call $gl8 (global.get $edi)))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
    (if (global.get $df)
      (then (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
      (else (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
    (call $next))
  (func $th_rep_cmpsb (param $op i32)
    ;; operand: 0=REPE, 1=REPNE
    (local $a i32) (local $b i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (local.set $a (call $gl8 (global.get $esi))) (local.set $b (call $gl8 (global.get $edi)))
      (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
      (if (global.get $df)
        (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1)))
              (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
        (else (global.set $esi (i32.add (global.get $esi) (i32.const 1)))
              (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (if (i32.eqz (local.get $op)) ;; REPE: stop if not equal
        (then (br_if $d (i32.ne (local.get $a) (local.get $b))))
        (else (br_if $d (i32.eq (local.get $a) (local.get $b))))) ;; REPNE: stop if equal
      (br $l))) (call $next))
  (func $th_rep_scasb (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (i32.and (global.get $eax) (i32.const 0xFF)))
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (local.set $b (call $gl8 (global.get $edi)))
      (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
      (if (global.get $df)
        (then (global.set $edi (i32.sub (global.get $edi) (i32.const 1))))
        (else (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (if (i32.eqz (local.get $op))
        (then (br_if $d (i32.ne (local.get $a) (local.get $b))))
        (else (br_if $d (i32.eq (local.get $a) (local.get $b)))))
      (br $l))) (call $next))

  ;; --- CMPSD/SCASD (dword variants) ---
  (func $th_cmpsd (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (call $gl32 (global.get $esi))) (local.set $b (call $gl32 (global.get $edi)))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4)))
            (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 4)))
            (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
    (call $next))
  (func $th_scasd (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (global.get $eax))
    (local.set $b (call $gl32 (global.get $edi)))
    (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
    (if (global.get $df)
      (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
      (else (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
    (call $next))
  (func $th_rep_cmpsd (param $op i32)
    ;; operand: 0=REPE, 1=REPNE
    (local $a i32) (local $b i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (local.set $a (call $gl32 (global.get $esi))) (local.set $b (call $gl32 (global.get $edi)))
      (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
      (if (global.get $df)
        (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4)))
              (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
        (else (global.set $esi (i32.add (global.get $esi) (i32.const 4)))
              (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (if (i32.eqz (local.get $op))
        (then (br_if $d (i32.ne (local.get $a) (local.get $b))))
        (else (br_if $d (i32.eq (local.get $a) (local.get $b)))))
      (br $l))) (call $next))
  (func $th_rep_scasd (param $op i32)
    (local $a i32) (local $b i32)
    (local.set $a (global.get $eax))
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (local.set $b (call $gl32 (global.get $edi)))
      (call $set_flags_sub (local.get $a) (local.get $b) (i32.sub (local.get $a) (local.get $b)))
      (if (global.get $df)
        (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4))))
        (else (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (if (i32.eqz (local.get $op))
        (then (br_if $d (i32.ne (local.get $a) (local.get $b))))
        (else (br_if $d (i32.eq (local.get $a) (local.get $b)))))
      (br $l))) (call $next))

  ;; --- CMPXCHG/XADD/CPUID ---
  (func $th_cmpxchg (param $op i32)
    ;; Register mode: op = 0x80 | dst<<4 | src
    ;; Memory mode: op = src_reg, next word = addr
    (local $dst_val i32) (local $src_reg i32) (local $addr i32) (local $is_mem i32)
    (if (i32.ge_u (local.get $op) (i32.const 0x80))
      (then
        ;; Register mode: op = 0x80 | dst<<4 | src
        (local.set $op (i32.and (local.get $op) (i32.const 0x7F)))
        (local.set $dst_val (call $get_reg (i32.shr_u (local.get $op) (i32.const 4))))
        (local.set $src_reg (i32.and (local.get $op) (i32.const 0xF)))
        (if (i32.eq (global.get $eax) (local.get $dst_val))
          (then
            (call $set_flags_sub (global.get $eax) (local.get $dst_val) (i32.const 0))
            (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (call $get_reg (local.get $src_reg))))
          (else
            (call $set_flags_sub (global.get $eax) (local.get $dst_val) (i32.sub (global.get $eax) (local.get $dst_val)))
            (global.set $eax (local.get $dst_val)))))
      (else
        ;; Memory mode: op=src_reg, next word=addr
        (local.set $src_reg (local.get $op))
        (local.set $addr (call $read_thread_word))
        (local.set $dst_val (call $gl32 (local.get $addr)))
        (if (i32.eq (global.get $eax) (local.get $dst_val))
          (then
            (call $set_flags_sub (global.get $eax) (local.get $dst_val) (i32.const 0))
            (call $gs32 (local.get $addr) (call $get_reg (local.get $src_reg))))
          (else
            (call $set_flags_sub (global.get $eax) (local.get $dst_val) (i32.sub (global.get $eax) (local.get $dst_val)))
            (global.set $eax (local.get $dst_val))))))
    (call $next))

  (func $th_xadd (param $op i32)
    (local $dst_val i32) (local $src_reg i32) (local $sum i32) (local $addr i32)
    (if (i32.ge_u (local.get $op) (i32.const 0x80))
      (then
        (local.set $op (i32.and (local.get $op) (i32.const 0x7F)))
        (local.set $src_reg (i32.and (local.get $op) (i32.const 0xF)))
        (local.set $dst_val (call $get_reg (i32.shr_u (local.get $op) (i32.const 4))))
        (local.set $sum (i32.add (local.get $dst_val) (call $get_reg (local.get $src_reg))))
        (call $set_flags_add (local.get $dst_val) (call $get_reg (local.get $src_reg)) (local.get $sum))
        (call $set_reg (local.get $src_reg) (local.get $dst_val))
        (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (local.get $sum)))
      (else
        (local.set $src_reg (local.get $op))
        (local.set $addr (call $read_thread_word))
        (local.set $dst_val (call $gl32 (local.get $addr)))
        (local.set $sum (i32.add (local.get $dst_val) (call $get_reg (local.get $src_reg))))
        (call $set_flags_add (local.get $dst_val) (call $get_reg (local.get $src_reg)) (local.get $sum))
        (call $set_reg (local.get $src_reg) (local.get $dst_val))
        (call $gs32 (local.get $addr) (local.get $sum))))
    (call $next))

  (func $th_cpuid (param $op i32)
    ;; Minimal CPUID: return "GenuineIntel" for leaf 0, basic features for leaf 1
    (if (i32.eqz (global.get $eax))
      (then
        (global.set $eax (i32.const 1))      ;; max leaf = 1
        (global.set $ebx (i32.const 0x756E6547)) ;; "Genu"
        (global.set $edx (i32.const 0x49656E69)) ;; "ineI"
        (global.set $ecx (i32.const 0x6C65746E))) ;; "ntel"
      (else
        (if (i32.eq (global.get $eax) (i32.const 1))
          (then
            (global.set $eax (i32.const 0x00000480)) ;; family 4, model 8 (486DX)
            (global.set $ebx (i32.const 0))
            (global.set $ecx (i32.const 0))
            (global.set $edx (i32.const 0x00000001))) ;; FPU present bit (so CRT init passes)
          (else
            (global.set $eax (i32.const 0))
            (global.set $ebx (i32.const 0))
            (global.set $ecx (i32.const 0))
            (global.set $edx (i32.const 0))))))
    (call $next))

  ;; --- Bit ops ---
  (func $th_bt_r_i8 (param $op i32)
    (local $bit i32) (local.set $bit (call $read_thread_word))
    ;; Set CF to the bit value
    (global.set $flag_op (i32.const 2)) ;; sub so CF works
    (if (i32.and (i32.shr_u (call $get_reg (local.get $op)) (local.get $bit)) (i32.const 1))
      (then (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1)))
      (else (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0))))
    (global.set $flag_res (i32.const 0)) ;; doesn't matter for CF
    (call $next))
  (func $th_bts_r_i8 (param $op i32)
    (local $bit i32) (local.set $bit (call $read_thread_word))
    (call $set_reg (local.get $op) (i32.or (call $get_reg (local.get $op)) (i32.shl (i32.const 1) (local.get $bit))))
    (call $next))
  (func $th_btr_r_i8 (param $op i32)
    (local $bit i32) (local.set $bit (call $read_thread_word))
    (call $set_reg (local.get $op) (i32.and (call $get_reg (local.get $op))
      (i32.xor (i32.shl (i32.const 1) (local.get $bit)) (i32.const -1))))
    (call $next))
  (func $th_btc_r_i8 (param $op i32)
    (local $bit i32) (local.set $bit (call $read_thread_word))
    (call $set_reg (local.get $op) (i32.xor (call $get_reg (local.get $op)) (i32.shl (i32.const 1) (local.get $bit))))
    (call $next))
  ;; --- BT/BTS/BTR/BTC r,r (198-201) ---
  ;; op = dst<<4|src, bit = get_reg(src) & 31
  (func $th_bt_r_r (param $op i32)
    (local $dst i32) (local $bit i32)
    (local.set $dst (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $bit (i32.and (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (i32.const 31)))
    (call $set_cf_bit (call $get_reg (local.get $dst)) (local.get $bit))
    (call $next))
  (func $th_bts_r_r (param $op i32)
    (local $dst i32) (local $bit i32)
    (local.set $dst (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $bit (i32.and (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (i32.const 31)))
    (call $set_cf_bit (call $get_reg (local.get $dst)) (local.get $bit))
    (call $set_reg (local.get $dst) (i32.or (call $get_reg (local.get $dst)) (i32.shl (i32.const 1) (local.get $bit))))
    (call $next))
  (func $th_btr_r_r (param $op i32)
    (local $dst i32) (local $bit i32)
    (local.set $dst (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $bit (i32.and (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (i32.const 31)))
    (call $set_cf_bit (call $get_reg (local.get $dst)) (local.get $bit))
    (call $set_reg (local.get $dst) (i32.and (call $get_reg (local.get $dst))
      (i32.xor (i32.shl (i32.const 1) (local.get $bit)) (i32.const -1))))
    (call $next))
  (func $th_btc_r_r (param $op i32)
    (local $dst i32) (local $bit i32)
    (local.set $dst (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $bit (i32.and (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (i32.const 31)))
    (call $set_cf_bit (call $get_reg (local.get $dst)) (local.get $bit))
    (call $set_reg (local.get $dst) (i32.xor (call $get_reg (local.get $dst)) (i32.shl (i32.const 1) (local.get $bit))))
    (call $next))
  ;; --- Memory BT/BTS/BTR/BTC with imm8 ---
  ;; All read addr from next word, bit from word after
  (func $set_cf_bit (param $val i32) (param $bit i32)
    (global.set $flag_op (i32.const 2))
    (if (i32.and (i32.shr_u (local.get $val) (local.get $bit)) (i32.const 1))
      (then (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1)))
      (else (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0))))
    (global.set $flag_res (i32.const 0)))
  (func $th_bt_m_i8 (param $op i32)
    (local $addr i32) (local $bit i32) (local $val i32)
    (local.set $addr (call $read_thread_word))
    (local.set $bit (call $read_thread_word))
    (local.set $val (call $gl32 (local.get $addr)))
    (call $set_cf_bit (local.get $val) (local.get $bit))
    (call $next))
  (func $th_bts_m_i8 (param $op i32)
    (local $addr i32) (local $bit i32) (local $val i32)
    (local.set $addr (call $read_thread_word))
    (local.set $bit (call $read_thread_word))
    (local.set $val (call $gl32 (local.get $addr)))
    (call $set_cf_bit (local.get $val) (local.get $bit))
    (call $gs32 (local.get $addr) (i32.or (local.get $val) (i32.shl (i32.const 1) (local.get $bit))))
    (call $next))
  (func $th_btr_m_i8 (param $op i32)
    (local $addr i32) (local $bit i32) (local $val i32)
    (local.set $addr (call $read_thread_word))
    (local.set $bit (call $read_thread_word))
    (local.set $val (call $gl32 (local.get $addr)))
    (call $set_cf_bit (local.get $val) (local.get $bit))
    (call $gs32 (local.get $addr) (i32.and (local.get $val) (i32.xor (i32.shl (i32.const 1) (local.get $bit)) (i32.const -1))))
    (call $next))
  (func $th_btc_m_i8 (param $op i32)
    (local $addr i32) (local $bit i32) (local $val i32)
    (local.set $addr (call $read_thread_word))
    (local.set $bit (call $read_thread_word))
    (local.set $val (call $gl32 (local.get $addr)))
    (call $set_cf_bit (local.get $val) (local.get $bit))
    (call $gs32 (local.get $addr) (i32.xor (local.get $val) (i32.shl (i32.const 1) (local.get $bit))))
    (call $next))

  (func $th_bsf (param $op i32)
    (local $src i32) (local $i i32)
    (local.set $src (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (if (i32.eqz (local.get $src))
      (then (call $set_flags_logic (i32.const 0))) ;; ZF=1
      (else
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.and (i32.shr_u (local.get $src) (local.get $i)) (i32.const 1)))
          (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
        (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (local.get $i))
        (call $set_flags_logic (i32.const 1)))) ;; ZF=0
    (call $next))
  (func $th_bsr (param $op i32)
    (local $src i32) (local $i i32)
    (local.set $src (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))
    (if (i32.eqz (local.get $src))
      (then (call $set_flags_logic (i32.const 0)))
      (else
        (local.set $i (i32.const 31))
        (block $d (loop $l
          (br_if $d (i32.and (i32.shr_u (local.get $src) (local.get $i)) (i32.const 1)))
          (local.set $i (i32.sub (local.get $i) (i32.const 1))) (br $l)))
        (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (local.get $i))
        (call $set_flags_logic (i32.const 1))))
    (call $next))

  ;; --- SETcc ---
  ;; 102: operand=cc, reg in next word
  (func $th_setcc (param $op i32)
    (local $reg i32) (local.set $reg (call $read_thread_word))
    (call $set_reg8 (local.get $reg) (call $eval_cc (local.get $op)))
    (call $next))
  (func $th_setcc_mem (param $op i32)
    (local $addr i32) (local.set $addr (call $read_thread_word))
    (call $gs8 (local.get $addr) (call $eval_cc (local.get $op)))
    (call $next))

  ;; --- SHLD/SHRD ---
  (func $th_shld (param $op i32)
    (local $count i32) (local $dst i32) (local $src i32) (local $d i32) (local $s i32)
    (local.set $count (i32.and (call $read_thread_word) (i32.const 31)))
    (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $s (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $dst (call $get_reg (local.get $d)))
    (local.set $src (call $get_reg (local.get $s)))
    (if (local.get $count) (then
      (call $set_reg (local.get $d)
        (i32.or (i32.shl (local.get $dst) (local.get $count))
                (i32.shr_u (local.get $src) (i32.sub (i32.const 32) (local.get $count)))))))
    (call $next))
  (func $th_shrd (param $op i32)
    (local $count i32) (local $dst i32) (local $src i32) (local $d i32) (local $s i32)
    (local.set $count (i32.and (call $read_thread_word) (i32.const 31)))
    (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (local.set $s (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $dst (call $get_reg (local.get $d)))
    (local.set $src (call $get_reg (local.get $s)))
    (if (local.get $count) (then
      (call $set_reg (local.get $d)
        (i32.or (i32.shr_u (local.get $dst) (local.get $count))
                (i32.shl (local.get $src) (i32.sub (i32.const 32) (local.get $count)))))))
    (call $next))

  ;; --- Misc ---
  (func $th_cdq (param $op i32)
    (global.set $edx (i32.shr_s (global.get $eax) (i32.const 31))) (call $next))
  (func $th_cbw (param $op i32)
    (local $al i32) (local.set $al (i32.and (global.get $eax) (i32.const 0xFF)))
    (if (i32.ge_u (local.get $al) (i32.const 0x80))
      (then (call $set_reg16 (i32.const 0) (i32.or (local.get $al) (i32.const 0xFF00))))
      (else (call $set_reg16 (i32.const 0) (local.get $al))))
    (call $next))
  (func $th_cwde (param $op i32)
    (local $ax i32) (local.set $ax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (if (i32.ge_u (local.get $ax) (i32.const 0x8000))
      (then (global.set $eax (i32.or (local.get $ax) (i32.const 0xFFFF0000))))
      (else (global.set $eax (local.get $ax))))
    (call $next))
  ;; CWD: sign-extend AX into DX:AX (16-bit CDQ)
  (func $th_cwd (param $op i32)
    (local $ax i32) (local.set $ax (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (if (i32.ge_u (local.get $ax) (i32.const 0x8000))
      (then (call $set_reg16 (i32.const 2) (i32.const 0xFFFF))) ;; DX = 0xFFFF
      (else (call $set_reg16 (i32.const 2) (i32.const 0))))     ;; DX = 0
    (call $next))
  ;; PUSH 16-bit register
  (func $th_push_r16 (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
    (call $gs16 (global.get $esp) (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF)))
    (call $next))
  ;; POP 16-bit register
  (func $th_pop_r16 (param $op i32)
    (call $set_reg16 (local.get $op) (call $gl16 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
    (call $next))
  ;; MOVSW: move word [ESI] → [EDI]
  (func $th_movsw (param $op i32)
    (call $gs16 (global.get $edi) (call $gl16 (global.get $esi)))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2)))
            (global.set $edi (i32.sub (global.get $edi) (i32.const 2))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 2)))
            (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
    (call $next))
  ;; STOSW: store AX at [EDI]
  (func $th_stosw (param $op i32)
    (call $gs16 (global.get $edi) (i32.and (global.get $eax) (i32.const 0xFFFF)))
    (if (global.get $df)
      (then (global.set $edi (i32.sub (global.get $edi) (i32.const 2))))
      (else (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
    (call $next))
  ;; LODSW: load word from [ESI] into AX
  (func $th_lodsw (param $op i32)
    (call $set_reg16 (i32.const 0) (call $gl16 (global.get $esi)))
    (if (global.get $df)
      (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2))))
      (else (global.set $esi (i32.add (global.get $esi) (i32.const 2)))))
    (call $next))
  ;; REP MOVSW
  (func $th_rep_movsw (param $op i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (call $gs16 (global.get $edi) (call $gl16 (global.get $esi)))
      (if (global.get $df)
        (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2)))
              (global.set $edi (i32.sub (global.get $edi) (i32.const 2))))
        (else (global.set $esi (i32.add (global.get $esi) (i32.const 2)))
              (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (br $l))) (call $next))
  ;; REP STOSW
  (func $th_rep_stosw (param $op i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (global.get $ecx)))
      (call $gs16 (global.get $edi) (i32.and (global.get $eax) (i32.const 0xFFFF)))
      (if (global.get $df)
        (then (global.set $edi (i32.sub (global.get $edi) (i32.const 2))))
        (else (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
      (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1)))
      (br $l))) (call $next))
  ;; 202: inc r16 — preserves upper 16 bits, sets flags with sign_shift=15
  (func $th_inc_r16 (param $op i32)
    (local $old i32) (local $r i32)
    (local.set $old (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF)))
    (local.set $r (i32.and (i32.add (local.get $old) (i32.const 1)) (i32.const 0xFFFF)))
    (call $set_reg (local.get $op) (i32.or (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF0000)) (local.get $r)))
    (call $set_flags_inc (local.get $old) (local.get $r))
    (global.set $flag_sign_shift (i32.const 15)) (call $next))
  ;; 203: dec r16 — preserves upper 16 bits, sets flags with sign_shift=15
  (func $th_dec_r16 (param $op i32)
    (local $old i32) (local $r i32)
    (local.set $old (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF)))
    (local.set $r (i32.and (i32.sub (local.get $old) (i32.const 1)) (i32.const 0xFFFF)))
    (call $set_reg (local.get $op) (i32.or (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF0000)) (local.get $r)))
    (call $set_flags_dec (local.get $old) (local.get $r))
    (global.set $flag_sign_shift (i32.const 15)) (call $next))
  ;; 204: test r16, r16 — AND two 16-bit regs, set flags only
  (func $th_test_r16_r16 (param $op i32)
    (local $v i32)
    (local.set $v (i32.and
      (i32.and (call $get_reg (i32.shr_u (local.get $op) (i32.const 4))) (i32.const 0xFFFF))
      (i32.and (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (i32.const 0xFFFF))))
    (global.set $flag_op (i32.const 6)) (global.set $flag_res (local.get $v))
    (global.set $flag_sign_shift (i32.const 15)) (call $next))
  ;; 205: test ax, imm16 — AND AX with immediate word, set flags only
  (func $th_test_ax_i16 (param $op i32)
    (local $v i32)
    (local.set $v (i32.and (i32.and (global.get $eax) (i32.const 0xFFFF)) (call $read_thread_word)))
    (global.set $flag_op (i32.const 6)) (global.set $flag_res (local.get $v))
    (global.set $flag_sign_shift (i32.const 15)) (call $next))

  ;; 206: r16 OP= r16 (op=alu_op<<8|dst<<4|src)
  (func $th_alu_r16_r16 (param $op i32)
    (local $alu i32) (local $dst i32) (local $val i32)
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 7)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu)
      (i32.and (call $get_reg (local.get $dst)) (i32.const 0xFFFF))
      (i32.and (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (i32.const 0xFFFF))))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg16 (local.get $dst) (local.get $val))))
    (call $next))
  ;; 207: r16 OP= imm16 (op=alu_op<<4|reg, imm in next word)
  (func $th_alu_r16_i16 (param $op i32)
    (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 7)))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu)
      (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF))
      (call $read_thread_word)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg16 (local.get $reg) (local.get $val))))
    (call $next))

  ;; 210: mov r16, r16 (op=dst<<4|src)
  (func $th_mov_r16_r16 (param $op i32)
    (call $set_reg16 (i32.shr_u (local.get $op) (i32.const 4))
      (i32.and (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (i32.const 0xFFFF)))
    (call $next))
  ;; 208: movzx r32, reg8 (op=dst<<4|src_byte_reg)
  (func $th_movzx_r_r8 (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $get_reg8 (i32.and (local.get $op) (i32.const 0xF))))
    (call $next))
  ;; 209: movsx r32, reg8 (op=dst<<4|src_byte_reg)
  (func $th_movsx_r_r8 (param $op i32)
    (local $v i32)
    (local.set $v (call $get_reg8 (i32.and (local.get $op) (i32.const 0xF))))
    ;; Sign extend from 8 to 32 bits
    (if (i32.and (local.get $v) (i32.const 0x80))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFFFF00)))))
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4)) (local.get $v))
    (call $next))

  ;; ============================================================
  ;; x87 FPU SUPPORT
  ;; ============================================================
  (func $fpu_get (param $i i32) (result f64)
    (f64.load (i32.add (i32.const 0x200)
      (i32.shl (i32.and (i32.add (global.get $fpu_top) (local.get $i)) (i32.const 7)) (i32.const 3)))))

  (func $fpu_set (param $i i32) (param $v f64)
    (f64.store (i32.add (i32.const 0x200)
      (i32.shl (i32.and (i32.add (global.get $fpu_top) (local.get $i)) (i32.const 7)) (i32.const 3)))
      (local.get $v)))

  (func $fpu_push (param $v f64)
    (global.set $fpu_top (i32.and (i32.sub (global.get $fpu_top) (i32.const 1)) (i32.const 7)))
    (call $fpu_set (i32.const 0) (local.get $v)))

  (func $fpu_pop (result f64)
    (local $v f64)
    (local.set $v (call $fpu_get (i32.const 0)))
    (global.set $fpu_top (i32.and (i32.add (global.get $fpu_top) (i32.const 1)) (i32.const 7)))
    (local.get $v))

  (func $fpu_compare (param $a f64) (param $b f64)
    (local $cc i32)
    (if (f64.lt (local.get $a) (local.get $b))
      (then (local.set $cc (i32.const 0x0100)))
      (else (if (f64.gt (local.get $a) (local.get $b))
        (then (local.set $cc (i32.const 0x0000)))
        (else (if (f64.eq (local.get $a) (local.get $b))
          (then (local.set $cc (i32.const 0x4000)))
          (else (local.set $cc (i32.const 0x4500))))))))
    (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xB8FF)) (local.get $cc))))

  (func $fpu_compare_eflags (param $a f64) (param $b f64)
    (if (f64.lt (local.get $a) (local.get $b))
      (then
        (global.set $flag_op (i32.const 2))
        (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1))
        (global.set $flag_res (i32.const 0xFFFFFFFF)))
      (else (if (f64.eq (local.get $a) (local.get $b))
        (then
          (global.set $flag_op (i32.const 3))
          (global.set $flag_res (i32.const 0)))
        (else (if (f64.gt (local.get $a) (local.get $b))
          (then
            (global.set $flag_op (i32.const 3))
            (global.set $flag_res (i32.const 1)))
          (else
            (global.set $flag_op (i32.const 2))
            (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1))
            (global.set $flag_res (i32.const 0)))))))))

  (func $fpu_arith (param $a f64) (param $b f64) (param $op i32) (result f64)
    (if (result f64) (i32.eq (local.get $op) (i32.const 0)) (then (f64.add (local.get $a) (local.get $b)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 1)) (then (f64.mul (local.get $a) (local.get $b)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 4)) (then (f64.sub (local.get $a) (local.get $b)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 5)) (then (f64.sub (local.get $b) (local.get $a)))
    (else (if (result f64) (i32.eq (local.get $op) (i32.const 6)) (then (f64.div (local.get $a) (local.get $b)))
    (else (f64.div (local.get $b) (local.get $a)))))))))))))

  (func $fpu_load_mem (param $addr i32) (param $group i32) (result f64)
    (if (result f64) (i32.eq (local.get $group) (i32.const 0))
      (then (f64.promote_f32 (f32.load (call $g2w (local.get $addr)))))
    (else (if (result f64) (i32.eq (local.get $group) (i32.const 4))
      (then (f64.load (call $g2w (local.get $addr))))
    (else (if (result f64) (i32.or (i32.eq (local.get $group) (i32.const 2)) (i32.eq (local.get $group) (i32.const 3)))
      (then (f64.convert_i32_s (i32.load (call $g2w (local.get $addr)))))
    (else (if (result f64) (i32.or (i32.eq (local.get $group) (i32.const 6)) (i32.eq (local.get $group) (i32.const 7)))
      (then (f64.convert_i32_s (i32.load16_s (call $g2w (local.get $addr)))))
    (else
      (f64.load (call $g2w (local.get $addr))))))))))))

  (func $fpu_exec_mem (param $group i32) (param $reg i32) (param $addr i32)
    (local $val f64)
    ;; Group 0 (D8) / Group 4 (DC): arithmetic with float32/float64
    (if (i32.or (i32.eq (local.get $group) (i32.const 0)) (i32.eq (local.get $group) (i32.const 4)))
      (then
        (local.set $val (call $fpu_load_mem (local.get $addr) (local.get $group)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (drop (call $fpu_pop)) (return)))
        (call $fpu_set (i32.const 0) (call $fpu_arith (call $fpu_get (i32.const 0)) (local.get $val) (local.get $reg)))
        (return)))
    ;; Group 2 (DA) / Group 6 (DE): arithmetic with int32/int16
    (if (i32.or (i32.eq (local.get $group) (i32.const 2)) (i32.eq (local.get $group) (i32.const 6)))
      (then
        (local.set $val (call $fpu_load_mem (local.get $addr) (local.get $group)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_compare (call $fpu_get (i32.const 0)) (local.get $val)) (drop (call $fpu_pop)) (return)))
        (call $fpu_set (i32.const 0) (call $fpu_arith (call $fpu_get (i32.const 0)) (local.get $val) (local.get $reg)))
        (return)))
    ;; Group 1 (D9): FLD/FST/FSTP float32, FLDCW, FNSTCW
    (if (i32.eq (local.get $group) (i32.const 1))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.promote_f32 (f32.load (call $g2w (local.get $addr))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (f32.store (call $g2w (local.get $addr)) (f32.demote_f64 (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (f32.store (call $g2w (local.get $addr)) (f32.demote_f64 (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (global.set $fpu_cw (i32.load16_u (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (i32.store16 (call $g2w (local.get $addr)) (global.get $fpu_cw)) (return)))
        (return)))
    ;; Group 5 (DD): FLD/FST/FSTP float64, FNSTSW m16
    (if (i32.eq (local.get $group) (i32.const 5))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.load (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (f64.store (call $g2w (local.get $addr)) (call $fpu_get (i32.const 0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (f64.store (call $g2w (local.get $addr)) (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then
            (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xC7FF))
              (i32.shl (global.get $fpu_top) (i32.const 11))))
            (i32.store16 (call $g2w (local.get $addr)) (global.get $fpu_sw)) (return)))
        (return)))
    ;; Group 3 (DB): FILD/FIST/FISTP int32, FLD/FSTP m80
    (if (i32.eq (local.get $group) (i32.const 3))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.convert_i32_s (call $gl32 (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (i32.store (call $g2w (local.get $addr)) (i32.trunc_sat_f64_s (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (i32.store (call $g2w (local.get $addr)) (i32.trunc_sat_f64_s (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_push (f64.load (call $g2w (local.get $addr)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (f64.store (call $g2w (local.get $addr)) (call $fpu_pop))
            (i32.store16 (call $g2w (i32.add (local.get $addr) (i32.const 8))) (i32.const 0)) (return)))
        (return)))
    ;; Group 7 (DF): FILD/FIST/FISTP int16, FILD/FISTP int64
    (if (i32.eq (local.get $group) (i32.const 7))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (f64.convert_i32_s (i32.load16_s (call $g2w (local.get $addr))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (i32.store16 (call $g2w (local.get $addr)) (i32.trunc_sat_f64_s (call $fpu_get (i32.const 0)))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (i32.store16 (call $g2w (local.get $addr)) (i32.trunc_sat_f64_s (call $fpu_pop))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_push (f64.convert_i64_s (i64.load (call $g2w (local.get $addr))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (i64.store (call $g2w (local.get $addr)) (i64.trunc_sat_f64_s (call $fpu_pop))) (return)))
        (return)))
  )

  (func $fpu_exec_reg (param $group i32) (param $reg i32) (param $rm i32)
    (local $v f64) (local $st0 f64)
    (local.set $st0 (call $fpu_get (i32.const 0)))
    ;; Group 0 (D8): arith ST(0), ST(rm)
    (if (i32.eq (local.get $group) (i32.const 0))
      (then
        (local.set $v (call $fpu_get (local.get $rm)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_compare (local.get $st0) (local.get $v)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_compare (local.get $st0) (local.get $v)) (drop (call $fpu_pop)) (return)))
        (call $fpu_set (i32.const 0) (call $fpu_arith (local.get $st0) (local.get $v) (local.get $reg)))
        (return)))
    ;; Group 1 (D9): FLD, FXCH, constants, transcendentals
    (if (i32.eq (local.get $group) (i32.const 1))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_push (call $fpu_get (local.get $rm))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then
            (local.set $v (call $fpu_get (local.get $rm)))
            (call $fpu_set (local.get $rm) (local.get $st0))
            (call $fpu_set (i32.const 0) (local.get $v))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 2)) (then (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then
            (if (i32.eq (local.get $rm) (i32.const 0))
              (then (call $fpu_set (i32.const 0) (f64.neg (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 1))
              (then (call $fpu_set (i32.const 0) (f64.abs (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4))
              (then (call $fpu_compare (local.get $st0) (f64.const 0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 5))
              (then (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xB8FF)) (i32.const 0x0400))) (return)))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then
            (if (i32.eq (local.get $rm) (i32.const 0)) (then (call $fpu_push (f64.const 1.0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 1)) (then (call $fpu_push (f64.const 3.321928094887362)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 2)) (then (call $fpu_push (f64.const 1.4426950408889634)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 3)) (then (call $fpu_push (f64.const 3.141592653589793)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4)) (then (call $fpu_push (f64.const 0.3010299957316877)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 5)) (then (call $fpu_push (f64.const 0.6931471805599453)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 6)) (then (call $fpu_push (f64.const 0.0)) (return)))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then
            (if (i32.eq (local.get $rm) (i32.const 2))
              (then ;; FPTAN: ST(0) = tan(ST(0)), push 1.0
                (call $fpu_set (i32.const 0) (call $host_math_tan (local.get $st0)))
                (call $fpu_push (f64.const 1.0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 3))
              (then ;; FPATAN: ST(1) = atan2(ST(1), ST(0)), pop
                (call $fpu_set (i32.const 1) (call $host_math_atan2 (call $fpu_get (i32.const 1)) (local.get $st0)))
                (drop (call $fpu_pop)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4))
              (then (call $fpu_set (i32.const 0) (f64.const 1.0)) (call $fpu_push (f64.const 0.0)) (return)))
            (if (i32.eq (local.get $rm) (i32.const 6))
              (then (global.set $fpu_top (i32.and (i32.sub (global.get $fpu_top) (i32.const 1)) (i32.const 7))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 7))
              (then (global.set $fpu_top (i32.and (i32.add (global.get $fpu_top) (i32.const 1)) (i32.const 7))) (return)))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then
            (if (i32.eq (local.get $rm) (i32.const 0))
              (then (global.set $fpu_sw (i32.and (global.get $fpu_sw) (i32.const 0xFBFF))) (return))) ;; FPREM result ready
            (if (i32.eq (local.get $rm) (i32.const 2))
              (then (call $fpu_set (i32.const 0) (f64.sqrt (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 3))
              (then ;; FSINCOS: ST(0) = sin, push cos
                (call $fpu_set (i32.const 0) (call $host_math_sin (local.get $st0)))
                (call $fpu_push (call $host_math_cos (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 4))
              (then (call $fpu_set (i32.const 0) (f64.nearest (local.get $st0))) (return)))
            (if (i32.eq (local.get $rm) (i32.const 6))
              (then (call $fpu_set (i32.const 0) (call $host_math_sin (local.get $st0))) (return))) ;; FSIN
            (if (i32.eq (local.get $rm) (i32.const 7))
              (then (call $fpu_set (i32.const 0) (call $host_math_cos (local.get $st0))) (return))) ;; FCOS
            (return)))
        (return)))
    ;; Group 2 (DA): FCMOV
    (if (i32.eq (local.get $group) (i32.const 2))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (if (call $get_cf) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (if (call $get_zf) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (if (i32.or (call $get_cf) (call $get_zf)) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (return)))
    ;; Group 3 (DB): FCMOVN, FNINIT, FNCLEX, FUCOMI, FCOMI
    (if (i32.eq (local.get $group) (i32.const 3))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (if (i32.eqz (call $get_cf)) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (if (i32.eqz (call $get_zf)) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (if (i32.eqz (i32.or (call $get_cf) (call $get_zf))) (then (call $fpu_set (i32.const 0) (call $fpu_get (local.get $rm))))) (return)))
        (if (i32.and (i32.eq (local.get $reg) (i32.const 4)) (i32.eq (local.get $rm) (i32.const 2)))
          (then (global.set $fpu_sw (i32.and (global.get $fpu_sw) (i32.const 0x7F00))) (return)))
        (if (i32.and (i32.eq (local.get $reg) (i32.const 4)) (i32.eq (local.get $rm) (i32.const 3)))
          (then (global.set $fpu_top (i32.const 0)) (global.set $fpu_cw (i32.const 0x037F)) (global.set $fpu_sw (i32.const 0)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_compare_eflags (local.get $st0) (call $fpu_get (local.get $rm))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_compare_eflags (local.get $st0) (call $fpu_get (local.get $rm))) (return)))
        (return)))
    ;; Group 4 (DC): arith ST(rm), ST(0)
    (if (i32.eq (local.get $group) (i32.const 4))
      (then
        (local.set $v (call $fpu_get (local.get $rm)))
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_set (local.get $rm) (f64.add (local.get $v) (local.get $st0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (call $fpu_set (local.get $rm) (f64.mul (local.get $v) (local.get $st0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $st0) (local.get $v))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $v) (local.get $st0))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $st0) (local.get $v))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $v) (local.get $st0))) (return)))
        (return)))
    ;; Group 5 (DD): FFREE, FST, FSTP, FUCOM, FUCOMP
    (if (i32.eq (local.get $group) (i32.const 5))
      (then
        (if (i32.eq (local.get $reg) (i32.const 0)) (then (return)))
        (if (i32.eq (local.get $reg) (i32.const 2))
          (then (call $fpu_set (local.get $rm) (local.get $st0)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 3))
          (then (call $fpu_set (local.get $rm) (local.get $st0)) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_compare (local.get $st0) (call $fpu_get (local.get $rm))) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_compare (local.get $st0) (call $fpu_get (local.get $rm))) (drop (call $fpu_pop)) (return)))
        (return)))
    ;; Group 6 (DE): FADDP/FMULP/FCOMPP/FSUBRP/FSUBP/FDIVRP/FDIVP
    (if (i32.eq (local.get $group) (i32.const 6))
      (then
        (local.set $v (call $fpu_get (local.get $rm)))
        (if (i32.eq (local.get $reg) (i32.const 0))
          (then (call $fpu_set (local.get $rm) (f64.add (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 1))
          (then (call $fpu_set (local.get $rm) (f64.mul (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        (if (i32.and (i32.eq (local.get $reg) (i32.const 3)) (i32.eq (local.get $rm) (i32.const 1)))
          (then (call $fpu_compare (local.get $st0) (call $fpu_get (i32.const 1))) (drop (call $fpu_pop)) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 4))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $st0) (local.get $v))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_set (local.get $rm) (f64.sub (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $st0) (local.get $v))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 7))
          (then (call $fpu_set (local.get $rm) (f64.div (local.get $v) (local.get $st0))) (drop (call $fpu_pop)) (return)))
        (return)))
    ;; Group 7 (DF): FNSTSW AX, FUCOMIP, FCOMIP
    (if (i32.eq (local.get $group) (i32.const 7))
      (then
        (if (i32.and (i32.eq (local.get $reg) (i32.const 4)) (i32.eq (local.get $rm) (i32.const 0)))
          (then
            (global.set $fpu_sw (i32.or (i32.and (global.get $fpu_sw) (i32.const 0xC7FF))
              (i32.shl (global.get $fpu_top) (i32.const 11))))
            (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (global.get $fpu_sw)))
            (return)))
        (if (i32.eq (local.get $reg) (i32.const 5))
          (then (call $fpu_compare_eflags (local.get $st0) (call $fpu_get (local.get $rm))) (drop (call $fpu_pop)) (return)))
        (if (i32.eq (local.get $reg) (i32.const 6))
          (then (call $fpu_compare_eflags (local.get $st0) (call $fpu_get (local.get $rm))) (drop (call $fpu_pop)) (return)))
        (return)))
  )

  ;; 188: FPU memory op — op=(group<<4)|reg, addr in next word
  (func $th_fpu_mem (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_thread_word))
    (if (i32.eq (local.get $addr) (i32.const 0xEADEAD))
      (then (local.set $addr (global.get $ea_temp))))
    (call $fpu_exec_mem
      (i32.shr_u (local.get $op) (i32.const 4))
      (i32.and (local.get $op) (i32.const 0xF))
      (local.get $addr))
    (call $next))

  ;; 189: FPU register op — op=(group<<8)|(reg<<4)|rm
  (func $th_fpu_reg (param $op i32)
    (call $fpu_exec_reg
      (i32.shr_u (local.get $op) (i32.const 8))
      (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF))
      (i32.and (local.get $op) (i32.const 0xF)))
    (call $next))

  ;; 190: FPU memory op with base+disp — op=(group<<8)|(reg<<4)|base, disp in next word
  (func $th_fpu_mem_ro (param $op i32)
    (call $fpu_exec_mem
      (i32.shr_u (local.get $op) (i32.const 8))
      (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF))
      (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))
    (call $next))

  (func $th_cld (param $op i32) (global.set $df (i32.const 0)) (call $next))
  (func $th_std (param $op i32) (global.set $df (i32.const 1)) (call $next))
  (func $th_clc (param $op i32)
    (global.set $flag_op (i32.const 3)) (global.set $flag_res (i32.const 0)) (call $next))
  (func $th_stc (param $op i32)
    (global.set $flag_op (i32.const 1)) (global.set $flag_a (i32.const 0xFFFFFFFF))
    (global.set $flag_b (i32.const 1)) (global.set $flag_res (i32.const 0)) (call $next))
  (func $th_cmc (param $op i32)
    ;; Toggle CF by flipping the condition that produces it
    (if (call $get_cf)
      (then (global.set $flag_op (i32.const 3)) (global.set $flag_res (i32.const 0)))
      (else (global.set $flag_op (i32.const 1)) (global.set $flag_a (i32.const 0xFFFFFFFF))
            (global.set $flag_b (i32.const 1)) (global.set $flag_res (i32.const 0))))
    (call $next))
  (func $th_leave (param $op i32)
    (global.set $esp (global.get $ebp))
    (global.set $ebp (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (call $next))
  (func $th_nop2 (param $op i32) (call $next))
  (func $th_bswap (param $op i32)
    (local $v i32) (local.set $v (call $get_reg (local.get $op)))
    (call $set_reg (local.get $op)
      (i32.or (i32.or
        (i32.shl (i32.and (local.get $v) (i32.const 0xFF)) (i32.const 24))
        (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 0xFF)) (i32.const 16)))
        (i32.or
          (i32.shl (i32.and (i32.shr_u (local.get $v) (i32.const 16)) (i32.const 0xFF)) (i32.const 8))
          (i32.shr_u (local.get $v) (i32.const 24)))))
    (call $next))
  (func $th_xchg_eax_r (param $op i32)
    (local $tmp i32) (local.set $tmp (global.get $eax))
    (global.set $eax (call $get_reg (local.get $op)))
    (call $set_reg (local.get $op) (local.get $tmp)) (call $next))
  (func $th_thunk_call (param $op i32)
    (call $win32_dispatch (local.get $op)))
  (func $th_imul_r_r (param $op i32)
    (local $d i32) (local.set $d (i32.shr_u (local.get $op) (i32.const 4)))
    (call $set_reg (local.get $d) (i32.mul (call $get_reg (local.get $d))
      (call $get_reg (i32.and (local.get $op) (i32.const 0xF))))) (call $next))
  ;; 157: imul reg, [base+disp] — 2-operand imul with memory source (simple base)
  (func $th_imul_r_m_ro (param $op i32)
    (local $addr i32) (local $dst i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (call $set_reg (local.get $dst) (i32.mul (call $get_reg (local.get $dst)) (call $gl32 (local.get $addr))))
    (call $next))
  ;; 158: imul reg, [addr] — 2-operand imul with memory source (absolute/SIB)
  (func $th_imul_r_m_abs (param $op i32)
    (local $addr i32) (local.set $addr (call $read_addr))
    (call $set_reg (local.get $op) (i32.mul (call $get_reg (local.get $op)) (call $gl32 (local.get $addr))))
    (call $next))
  ;; 159: r16 OP= [addr] (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_r16_m16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr))))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (call $next))
  ;; 160: [addr] OP= r16 (op=alu_op<<4|reg, addr in next word)
  (func $th_alu_m16_r16 (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $read_addr))
    (local.set $reg (i32.and (local.get $op) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF))))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs16 (local.get $addr) (local.get $val))))
    (call $next))
  ;; 161: r16 OP= [base+disp] (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_r16_m16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)) (call $gl16 (local.get $addr))))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $set_reg (local.get $reg) (i32.or (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF0000)) (i32.and (local.get $val) (i32.const 0xFFFF))))))
    (call $next))
  ;; 162: [base+disp] OP= r16 (op=alu_op<<8|reg<<4|base, disp in word)
  (func $th_alu_m16_r16_ro (param $op i32)
    (local $addr i32) (local $reg i32) (local $alu i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0x7)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl16 (local.get $addr)) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF))))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $alu) (i32.const 7))
      (then (call $gs16 (local.get $addr) (local.get $val))))
    (call $next))
  ;; 163: mov [addr], r16 (op=reg, addr in next word)
  (func $th_mov_m16_r16 (param $op i32)
    (call $gs16 (call $read_addr) (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF)))
    (call $next))
  ;; 164: mov r16, [addr] (op=reg, addr in next word)
  (func $th_mov_r16_m16 (param $op i32)
    (local $val i32) (local.set $val (call $gl16 (call $read_addr)))
    (call $set_reg (local.get $op) (i32.or (i32.and (call $get_reg (local.get $op)) (i32.const 0xFFFF0000)) (local.get $val)))
    (call $next))
  ;; 165: mov [base+disp], r16 (op=reg<<4|base, disp in word)
  (func $th_mov_m16_r16_ro (param $op i32)
    (local $addr i32) (local $reg i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (call $gs16 (local.get $addr) (i32.and (call $get_reg (local.get $reg)) (i32.const 0xFFFF)))
    (call $next))
  ;; 166: mov r16, [base+disp] (op=reg<<4|base, disp in word)
  (func $th_mov_r16_m16_ro (param $op i32)
    (local $addr i32) (local $dst i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $dst (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $gl16 (local.get $addr)))
    (call $set_reg (local.get $dst) (i32.or (i32.and (call $get_reg (local.get $dst)) (i32.const 0xFFFF0000)) (local.get $val)))
    (call $next))
  ;; 167: mov [addr], imm16 (op=0, addr+imm in words)
  (func $th_mov_m16_i16 (param $op i32)
    (local $addr i32)
    (local.set $addr (call $read_addr))
    (call $gs16 (local.get $addr) (call $read_thread_word))
    (call $next))
  ;; 168: mov [base+disp], imm16 (op=base, disp+imm in words)
  (func $th_mov_m16_i16_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (i32.add (call $get_reg (local.get $op)) (call $read_thread_word)))
    (call $gs16 (local.get $addr) (call $read_thread_word))
    (call $next))
  (func $th_call_r (param $op i32)
    (local $reg i32) (local $target i32)
    (local.set $reg (call $read_thread_word))
    (local.set $target (call $get_reg (local.get $reg)))
    ;; Check thunk zone (guest-space bounds)
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $op))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $op))))
        (return)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $op))
    (global.set $eip (local.get $target)))
  (func $th_jmp_r (param $op i32)
    (global.set $eip (call $get_reg (local.get $op))))
  (func $th_push_m32 (param $op i32)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (call $read_addr))) (call $next))
  (func $th_alu_m16_i16 (param $op i32)
    (local $addr i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $read_addr)) (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $op) (call $gl16 (local.get $addr)) (local.get $imm)))
    (global.set $flag_sign_shift (i32.const 15))
    (if (i32.ne (local.get $op) (i32.const 7)) (then (call $gs16 (local.get $addr) (local.get $val))))
    (call $next))
  (func $th_load8s (param $op i32)
    (local $v i32) (local.set $v (call $gl8 (call $read_addr)))
    (if (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (local.set $v (i32.or (local.get $v) (i32.const 0xFFFFFF00)))))
    (call $set_reg (local.get $op) (local.get $v)) (call $next))
  (func $th_test_m8_i8 (param $op i32)
    (call $set_flags_logic (i32.and (call $gl8 (call $read_thread_word)) (local.get $op))) (call $next))

  ;; 125: jmp [mem] — for jmp through IAT or vtable
  ;; operand=ignored, mem_addr in next thread word
  (func $th_jmp_ind (param $op i32)
    (local $mem_addr i32) (local $target i32) (local $ret_addr i32)
    (local.set $mem_addr (call $read_addr))
    (local.set $target (call $gl32 (local.get $mem_addr)))
    ;; Check thunk zone (guest-space bounds) — JMP, not CALL. Return addr already on stack.
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (local.set $ret_addr (call $gl32 (global.get $esp)))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $ret_addr))))
        (return)))
    ;; Not a thunk — regular indirect jump
    (global.set $eip (local.get $target)))

  ;; --- Runtime EA handlers (compute address from base_reg + disp at execution time) ---

  ;; 126: LEA dst, [base+disp]. operand=dst<<4|base, disp in next word.
  (func $th_lea_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))
    (call $next))

  ;; 148: LEA dst, [base+index*scale+disp]. op=dst. Words: base|index<<4|scale<<8, disp.
  (func $th_lea_sib (param $op i32)
    (local $info i32) (local $base_val i32) (local $index_val i32) (local $scale i32) (local $disp i32)
    (local.set $info (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    ;; base: low 4 bits (0xF = no base)
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $base_val (call $get_reg (i32.and (local.get $info) (i32.const 0xF))))))
    ;; index: bits 4-7 (0xF = no index)
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then
        (local.set $scale (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3)))
        (local.set $index_val (i32.shl
          (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
          (local.get $scale)))))
    (call $set_reg (local.get $op)
      (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp)))
    (call $next))

  ;; 149: compute SIB EA → ea_temp, then continue to next handler
  (func $th_compute_ea_sib (param $op i32)
    (local $info i32) (local $base_val i32) (local $index_val i32) (local $scale i32) (local $disp i32)
    (local.set $info (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    (if (i32.ne (i32.and (local.get $info) (i32.const 0xF)) (i32.const 0xF))
      (then (local.set $base_val (call $get_reg (i32.and (local.get $info) (i32.const 0xF))))))
    (if (i32.ne (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF))
      (then
        (local.set $scale (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 3)))
        (local.set $index_val (i32.shl
          (call $get_reg (i32.and (i32.shr_u (local.get $info) (i32.const 4)) (i32.const 0xF)))
          (local.get $scale)))))
    (global.set $ea_temp (i32.add (i32.add (local.get $base_val) (local.get $index_val)) (local.get $disp)))
    (call $next))

  ;; Helper: compute EA from operand encoding (alu_op<<8 | reg<<4 | base)
  (func $ea_from_op (param $op i32) (result i32)
    (i32.add (call $get_reg (i32.and (local.get $op) (i32.const 0xF))) (call $read_thread_word)))

  ;; 127: [base+disp] OP= reg32. operand = alu_op<<8 | reg<<4 | base. disp in next word.
  (func $th_alu_m32_r_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl32 (local.get $addr)) (call $get_reg (local.get $reg))))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (call $next))

  ;; 128: reg32 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m32_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $get_reg (local.get $reg)) (call $gl32 (local.get $addr))))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg (local.get $reg) (local.get $val))))
    (call $next))

  ;; 129: [base+disp] OP= reg8. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_m8_r_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl8 (local.get $addr)) (call $get_reg8 (local.get $reg))))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (call $next))

  ;; 130: reg8 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m8_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $get_reg8 (local.get $reg)) (call $gl8 (local.get $addr))))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $set_reg8 (local.get $reg) (local.get $val))))
    (call $next))

  ;; 131: [base+disp] OP= imm32. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m32_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl32 (local.get $addr)) (local.get $imm)))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs32 (local.get $addr) (local.get $val))))
    (call $next))

  ;; 132: [base+disp] OP= imm8. operand = alu_op<<8 | base. disp+imm in next words.
  (func $th_alu_m8_i_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $imm i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $imm (call $read_thread_word))
    (local.set $val (call $do_alu32 (local.get $alu) (call $gl8 (local.get $addr)) (local.get $imm)))
    (global.set $flag_sign_shift (i32.const 7))
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (call $next))

  ;; 133: mov [base+disp], imm32. op=base, disp+imm in next words.
  (func $th_mov_m32_i32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs32 (local.get $addr) (call $read_thread_word))
    (call $next))
  ;; 134: mov [base+disp], imm8.
  (func $th_mov_m8_i8_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (call $gs8 (local.get $addr) (call $read_thread_word))
    (call $next))
  ;; 135: inc/dec/not/neg [base+disp]. op=unary_op<<4|base, disp in word.
  (func $th_unary_m32_ro (param $op i32)
    (local $addr i32) (local $uop i32) (local $old i32) (local $r i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $uop (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $old (call $gl32 (local.get $addr)))
    (if (i32.eq (local.get $uop) (i32.const 0))
      (then (local.set $r (i32.add (local.get $old) (i32.const 1)))
            (call $set_flags_inc (local.get $old) (local.get $r))))
    (if (i32.eq (local.get $uop) (i32.const 1))
      (then (local.set $r (i32.sub (local.get $old) (i32.const 1)))
            (call $set_flags_dec (local.get $old) (local.get $r))))
    (if (i32.eq (local.get $uop) (i32.const 2))
      (then (local.set $r (i32.xor (local.get $old) (i32.const -1)))))
    (if (i32.eq (local.get $uop) (i32.const 3))
      (then (local.set $r (i32.sub (i32.const 0) (local.get $old)))
            (call $set_flags_sub (i32.const 0) (local.get $old) (local.get $r))))
    (call $gs32 (local.get $addr) (local.get $r)) (call $next))
  ;; 136: test [base+disp], reg. op=reg<<4|base, disp in word.
  (func $th_test_m32_r_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $addr))
      (call $get_reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))))
    (call $next))
  ;; 137: test [base+disp], imm32. op=base, disp+imm in words.
  (func $th_test_m32_i32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $addr)) (call $read_thread_word)))
    (call $next))
  ;; 138: test [base+disp], imm8. op=base, disp+imm in words.
  (func $th_test_m8_i8_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (drop (call $do_alu32 (i32.const 4) (call $gl8 (local.get $addr)) (call $read_thread_word)))
    (call $next))
  ;; 139: shift [base+disp]. op=base, next word=shift_info (type<<8|count), next word=disp.
  ;; Wait — ea_from_op reads disp as first word. So: op=base, word1=disp (from ea_from_op), word2=shift_info.
  ;; Actually let me not use ea_from_op here for flexibility. op=base, w1=disp, w2=shift_type<<8|count.
  (func $th_shift_m32_ro (param $op i32)
    (local $addr i32) (local $info i32) (local $stype i32) (local $count i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $info (call $read_thread_word))
    (local.set $stype (i32.and (i32.shr_u (local.get $info) (i32.const 8)) (i32.const 7)))
    (local.set $count (i32.and (local.get $info) (i32.const 0xFF)))
    (if (i32.eqz (local.get $count)) (then (local.set $count (i32.and (global.get $ecx) (i32.const 31)))))
    (local.set $val (call $gl32 (local.get $addr)))
    (call $gs32 (local.get $addr) (call $do_shift32 (local.get $stype) (local.get $val) (local.get $count)))
    (call $next))
  ;; 140: call [base+disp]. op=ret_addr, w1=base, w2=disp.
  ;; Different encoding: we need ret_addr in operand AND base+disp. Pack base in w1, disp in w2.
  (func $th_call_ind_ro (param $op i32)
    (local $base i32) (local $disp i32) (local $mem_addr i32) (local $target i32)
    (local.set $base (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    (local.set $mem_addr (i32.add (call $get_reg (local.get $base)) (local.get $disp)))
    (local.set $target (call $gl32 (local.get $mem_addr)))
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $op))
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (if (global.get $steps) (then (global.set $eip (local.get $op))))
        (return)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $op))
    (global.set $eip (local.get $target)))
  ;; 141: jmp [base+disp]. op=0, w1=base, w2=disp.
  (func $th_jmp_ind_ro (param $op i32)
    (local $base i32) (local $disp i32) (local $mem_addr i32) (local $target i32)
    (local.set $base (call $read_thread_word))
    (local.set $disp (call $read_thread_word))
    (local.set $mem_addr (i32.add (call $get_reg (local.get $base)) (local.get $disp)))
    (local.set $target (call $gl32 (local.get $mem_addr)))
    (if (i32.and (i32.ge_u (local.get $target) (global.get $thunk_guest_base))
                 (i32.lt_u (local.get $target) (global.get $thunk_guest_end)))
      (then
        (call $win32_dispatch (i32.div_u (i32.sub (local.get $target) (global.get $thunk_guest_base)) (i32.const 8)))
        (return)))
    (global.set $eip (local.get $target)))
  ;; 142: push [base+disp]. op=base, disp in word.
  (func $th_push_m32_ro (param $op i32)
    (local $addr i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (local.get $addr)))
    (call $next))
  ;; 143-146: movzx/movsx [base+disp] variants. op=dst<<4|base, disp in word.
  (func $th_movzx8_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl8 (call $ea_from_op (local.get $op))))
    (call $next))
  (func $th_movsx8_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $sign_ext8 (call $gl8 (call $ea_from_op (local.get $op)))))
    (call $next))
  (func $th_movzx16_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $gl16 (call $ea_from_op (local.get $op))))
    (call $next))
  (func $th_movsx16_ro (param $op i32)
    (call $set_reg (i32.shr_u (local.get $op) (i32.const 4))
      (call $sign_ext16 (call $gl16 (call $ea_from_op (local.get $op)))))
    (call $next))
  ;; 147: mul/imul/div/idiv [base+disp]. op=type<<4|base, disp in word. type: 0=mul,1=imul,2=div,3=idiv
  (func $th_muldiv_m32_ro (param $op i32)
    (local $addr i32) (local $mtype i32) (local $mval i32) (local $val64 i64) (local $divisor i64) (local $dividend i64)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $mtype (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $mval (call $gl32 (local.get $addr)))
    (if (i32.eq (local.get $mtype) (i32.const 0)) ;; MUL
      (then (local.set $val64 (i64.mul (i64.extend_i32_u (global.get $eax)) (i64.extend_i32_u (local.get $mval))))
            (global.set $eax (i32.wrap_i64 (local.get $val64)))
            (global.set $edx (i32.wrap_i64 (i64.shr_u (local.get $val64) (i64.const 32))))
            (call $set_flags_mul (i32.ne (global.get $edx) (i32.const 0)))))
    (if (i32.eq (local.get $mtype) (i32.const 1)) ;; IMUL
      (then (local.set $val64 (i64.mul (i64.extend_i32_s (global.get $eax)) (i64.extend_i32_s (local.get $mval))))
            (global.set $eax (i32.wrap_i64 (local.get $val64)))
            (global.set $edx (i32.wrap_i64 (i64.shr_s (local.get $val64) (i64.const 32))))
            (call $set_flags_mul (i32.ne (global.get $edx) (i32.shr_s (global.get $eax) (i32.const 31))))))
    (if (i32.eq (local.get $mtype) (i32.const 2)) ;; DIV
      (then (local.set $divisor (i64.extend_i32_u (local.get $mval)))
            (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
              (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
            (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 2)) (return)))
            (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $dividend) (local.get $divisor))))
            (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor))))))
    (if (i32.eq (local.get $mtype) (i32.const 3)) ;; IDIV
      (then (local.set $divisor (i64.extend_i32_s (local.get $mval)))
            (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
              (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
            (if (i64.eqz (local.get $divisor)) (then (call $raise_exception (i32.const 3)) (return)))
            (global.set $eax (i32.wrap_i64 (i64.div_s (local.get $dividend) (local.get $divisor))))
            (global.set $edx (i32.wrap_i64 (i64.rem_s (local.get $dividend) (local.get $divisor))))))
    (call $next))

  ;; ============================================================
  ;; x86 DECODER — Full i486 with ModR/M + SIB
  ;; ============================================================

  ;; Decode ModR/M + optional SIB + displacement.
  ;; Returns the effective address as a guest virtual address.
  ;; Advances $d_pc (decoder PC, guest addr).
  ;; $d_pc is a global used during decoding.
  (global $d_pc (mut i32) (i32.const 0))

  ;; Read next byte from guest at d_pc, advance d_pc
  (func $d_fetch8 (result i32)
    (local $v i32)
    (local.set $v (call $gl8 (global.get $d_pc)))
    (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 1)))
    (local.get $v))
  (func $d_fetch16 (result i32)
    (local $v i32)
    (local.set $v (call $gl16 (global.get $d_pc)))
    (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 2)))
    (local.get $v))
  (func $d_fetch32 (result i32)
    (local $v i32)
    (local.set $v (call $gl32 (global.get $d_pc)))
    (global.set $d_pc (i32.add (global.get $d_pc) (i32.const 4)))
    (local.get $v))
  (func $sign_ext8 (param $v i32) (result i32)
    (if (result i32) (i32.ge_u (local.get $v) (i32.const 0x80))
      (then (i32.or (local.get $v) (i32.const 0xFFFFFF00)))
      (else (local.get $v))))
  (func $sign_ext16 (param $v i32) (result i32)
    (if (result i32) (i32.ge_u (local.get $v) (i32.const 0x8000))
      (then (i32.or (local.get $v) (i32.const 0xFFFF0000)))
      (else (local.get $v))))

  ;; Decode SIB byte and return base+index*scale
  (func $decode_sib (param $mod i32) (result i32)
    (local $sib i32) (local $scale i32) (local $index i32) (local $base i32) (local $addr i32)
    (local.set $sib (call $d_fetch8))
    (local.set $scale (i32.shr_u (local.get $sib) (i32.const 6)))
    (local.set $index (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    (local.set $base (i32.and (local.get $sib) (i32.const 7)))
    ;; Base
    (if (i32.and (i32.eq (local.get $base) (i32.const 5)) (i32.eq (local.get $mod) (i32.const 0)))
      (then (local.set $addr (call $d_fetch32))) ;; disp32, no base
      (else (local.set $addr (call $get_reg (local.get $base)))))
    ;; Index (4 = no index)
    (if (i32.ne (local.get $index) (i32.const 4))
      (then (local.set $addr (i32.add (local.get $addr)
        (i32.shl (call $get_reg (local.get $index)) (local.get $scale))))))
    (local.get $addr))

  ;; Decode ModR/M — returns addressing mode info for RUNTIME resolution.
  ;; For mod=11: mr_val = rm register index
  ;; For mod!=11: mr_base = base reg (-1 if none), mr_disp = displacement,
  ;;   mr_index = index reg (-1 if none), mr_scale = SIB scale
  ;; The caller must emit thread ops that compute addr at runtime.
  (global $mr_mod   (mut i32) (i32.const 0))
  (global $mr_reg   (mut i32) (i32.const 0))
  (global $mr_val   (mut i32) (i32.const 0))  ;; rm register index (mod=11 only)
  (global $mr_base  (mut i32) (i32.const -1)) ;; base register (-1=none)
  (global $mr_disp  (mut i32) (i32.const 0))  ;; displacement
  (global $mr_index (mut i32) (i32.const -1)) ;; SIB index register (-1=none)
  (global $mr_scale (mut i32) (i32.const 0))  ;; SIB scale (0-3)

  (func $decode_modrm
    (local $modrm i32) (local $mod i32) (local $rm i32)
    (local $sib i32)
    (global.set $mr_base (i32.const -1))
    (global.set $mr_disp (i32.const 0))
    (global.set $mr_index (i32.const -1))
    (global.set $mr_scale (i32.const 0))

    (local.set $modrm (call $d_fetch8))
    (local.set $mod (i32.shr_u (local.get $modrm) (i32.const 6)))
    (global.set $mr_reg (i32.and (i32.shr_u (local.get $modrm) (i32.const 3)) (i32.const 7)))
    (local.set $rm (i32.and (local.get $modrm) (i32.const 7)))
    (global.set $mr_mod (local.get $mod))

    ;; mod=11: register direct
    (if (i32.eq (local.get $mod) (i32.const 3))
      (then (global.set $mr_val (local.get $rm)) (return)))

    ;; mod=00
    (if (i32.eq (local.get $mod) (i32.const 0))
      (then
        (if (i32.eq (local.get $rm) (i32.const 4)) ;; SIB
          (then (call $decode_sib_info (i32.const 0)) (return)))
        (if (i32.eq (local.get $rm) (i32.const 5)) ;; disp32 only
          (then (global.set $mr_disp (call $d_fetch32)) (return)))
        ;; [reg] only
        (global.set $mr_base (local.get $rm))
        (return)))

    ;; mod=01: [rm + disp8]
    (if (i32.eq (local.get $mod) (i32.const 1))
      (then
        (if (i32.eq (local.get $rm) (i32.const 4))
          (then (call $decode_sib_info (i32.const 1)))
          (else (global.set $mr_base (local.get $rm))))
        (global.set $mr_disp (i32.add (global.get $mr_disp) (call $sign_ext8 (call $d_fetch8))))
        (return)))

    ;; mod=10: [rm + disp32]
    (if (i32.eq (local.get $rm) (i32.const 4))
      (then (call $decode_sib_info (i32.const 2)))
      (else (global.set $mr_base (local.get $rm))))
    (global.set $mr_disp (i32.add (global.get $mr_disp) (call $d_fetch32)))
  )

  ;; Apply FS segment override to mr_disp (call after decode_modrm when mr_mod != 3)
  (func $apply_seg_override
    (if (i32.eq (global.get $d_seg) (i32.const 5))
      (then (global.set $mr_disp (i32.add (global.get $mr_disp) (global.get $fs_base))))))

  ;; Decode SIB, store base/index/scale info (not resolved)
  (func $decode_sib_info (param $mod i32)
    (local $sib i32) (local $base i32) (local $index i32)
    (local.set $sib (call $d_fetch8))
    (global.set $mr_scale (i32.shr_u (local.get $sib) (i32.const 6)))
    (local.set $index (i32.and (i32.shr_u (local.get $sib) (i32.const 3)) (i32.const 7)))
    (local.set $base (i32.and (local.get $sib) (i32.const 7)))
    ;; Index 4 means no index
    (if (i32.ne (local.get $index) (i32.const 4))
      (then (global.set $mr_index (local.get $index))))
    ;; Base 5 with mod=0 means disp32 only
    (if (i32.and (i32.eq (local.get $base) (i32.const 5)) (i32.eq (local.get $mod) (i32.const 0)))
      (then (global.set $mr_disp (call $d_fetch32)))
      (else (global.set $mr_base (local.get $base)))))

  ;; Emit SIB EA compute prefix if needed, then return the address word to emit.
  ;; If SIB: emits compute_ea_sib handler and returns sentinel 0xEADEAD.
  ;; If absolute: returns mr_disp directly.
  (func $emit_sib_or_abs (result i32)
    (if (i32.ne (global.get $mr_index) (i32.const -1))
      (then
        (call $te (i32.const 149) (i32.const 0))
        (call $te_raw (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
                  (i32.shl (global.get $mr_scale) (i32.const 8)))))
        (call $te_raw (global.get $mr_disp))
        (return (i32.const 0xEADEAD))))
    (global.get $mr_disp))

  ;;
  ;; Simplest approach: add a $mr_ea_to_thread function that emits ops to
  ;; compute the address into a specific register or thread-word sequence.
  ;; For the common case [reg+disp], emit the (reg<<4|0, disp) operands directly.
  ;; For [disp32] (no base), emit (addr) directly.
  ;; For SIB with index, we need a more complex approach.
  ;;
  ;; Let's handle the common cases and fall back for complex SIB.

  ;; ============================================================
  ;; EMIT HELPERS — emit thread ops for memory access with runtime EA
  ;; ============================================================
  ;; After decode_modrm, mr_base/mr_disp/mr_index/mr_scale describe the EA.
  ;; These helpers emit the correct handler ops based on the addressing mode.

  ;; Helper: has base reg, no SIB index?
  (func $mr_simple_base (result i32)
    (i32.and (i32.ne (global.get $mr_base) (i32.const -1)) (i32.eq (global.get $mr_index) (i32.const -1))))
  ;; Helper: absolute address (no base, no index)?
  (func $mr_absolute (result i32)
    (i32.and (i32.eq (global.get $mr_base) (i32.const -1)) (i32.eq (global.get $mr_index) (i32.const -1))))

  (func $emit_load32 (param $dst i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 26) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 20) (local.get $dst)) (call $te_raw (local.get $a)))

  (func $emit_store32 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 27) (i32.or (i32.shl (local.get $src) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 21) (local.get $src)) (call $te_raw (local.get $a)))

  (func $emit_load8 (param $dst i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 28) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 24) (local.get $dst)) (call $te_raw (local.get $a)))

  (func $emit_store8 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 29) (i32.or (i32.shl (local.get $src) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 25) (local.get $src)) (call $te_raw (local.get $a)))

  (func $emit_lea (param $dst i32)
    ;; LEA computes address without memory access
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then
        (if (i32.eqz (global.get $mr_disp))
          (then (call $te (i32.const 11) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base))))
          (else ;; dst = base + disp (runtime). Use th_lea_ro (handler 126)
            (call $te (i32.const 126) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp))))
        (return)))
    ;; SIB with index: use th_lea_sib (handler 148)
    (if (i32.ne (global.get $mr_index) (i32.const -1))
      (then
        (call $te (i32.const 148) (local.get $dst))
        ;; Encode: base (0xF if none) | index<<4 | scale<<8
        (call $te_raw (i32.or
          (if (result i32) (i32.ne (global.get $mr_base) (i32.const -1))
            (then (global.get $mr_base)) (else (i32.const 0xF)))
          (i32.or (i32.shl (global.get $mr_index) (i32.const 4))
                  (i32.shl (global.get $mr_scale) (i32.const 8)))))
        (call $te_raw (global.get $mr_disp))
        (return)))
    ;; Absolute: LEA reg, [const] = MOV reg, const
    (call $te (i32.const 2) (local.get $dst)) (call $te_raw (global.get $mr_disp)))

  ;; ALU [mem] OP= reg (runtime address)
  (func $emit_alu_m32_r (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 127) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
          (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
        (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 47) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  (func $emit_alu_r_m32 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 128) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
          (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
        (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 48) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  (func $emit_alu_m8_r (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 129) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 49) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  (func $emit_alu_r_m8 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 130) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 50) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))

  ;; ALU [mem] OP= imm
  (func $emit_alu_m16_i (param $alu_op i32) (param $imm i32) (local $a i32)
    ;; 16-bit ALU [mem], imm16 — use handler 122 (th_alu_m16_i16)
    ;; For base+disp, fall through to 32-bit (TODO: proper 16-bit handler)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 131) (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 122) (local.get $alu_op))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))
  ;; 16-bit: r16 OP= [mem]
  (func $emit_alu_r16_m16 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 161) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 159) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))
  ;; 16-bit: [mem] OP= r16
  (func $emit_alu_m16_r16 (param $alu_op i32) (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 162) (i32.or (i32.shl (local.get $alu_op) (i32.const 8))
              (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base))))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 160) (i32.or (i32.shl (local.get $alu_op) (i32.const 4)) (local.get $reg)))
    (call $te_raw (local.get $a)))
  ;; 16-bit: MOV r16, [mem]
  (func $emit_load16 (param $dst i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 166) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 164) (local.get $dst)) (call $te_raw (local.get $a)))
  ;; 16-bit: MOV [mem], r16
  (func $emit_store16 (param $src i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 165) (i32.or (i32.shl (local.get $src) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 163) (local.get $src)) (call $te_raw (local.get $a)))
  ;; 16-bit: MOV [mem], imm16
  (func $emit_store16_imm (param $imm i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 168) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 167) (i32.const 0))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))
  (func $emit_alu_m32_i (param $alu_op i32) (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 131) (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 51) (local.get $alu_op))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  (func $emit_alu_m8_i (param $alu_op i32) (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 132) (i32.or (i32.shl (local.get $alu_op) (i32.const 8)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 52) (local.get $alu_op))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  ;; MOV [mem], imm32
  (func $emit_store32_imm (param $imm i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 133) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 76) (i32.const 0))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  ;; MOV [mem], imm8
  (func $emit_store8_imm (param $imm i32) (local $a i32)
    (call $apply_seg_override)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 134) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 77) (local.get $imm))
    (call $te_raw (local.get $a)))

  ;; Unary (inc/dec/not/neg) [mem32]
  (func $emit_unary_m32 (param $uop i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 135) (i32.or (i32.shl (local.get $uop) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 68) (local.get $uop))
    (call $te_raw (local.get $a)))

  ;; TEST [mem32], reg
  (func $emit_test_m32_r (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 136) (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 74) (local.get $reg))
    (call $te_raw (local.get $a)))

  (func $emit_test_m8_r (param $reg i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 152) (i32.or (i32.shl (local.get $reg) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 151) (local.get $reg))
    (call $te_raw (local.get $a)))

  ;; TEST [mem32], imm32
  (func $emit_test_m32_i (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 137) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 75) (i32.const 0))
    (call $te_raw (local.get $a)) (call $te_raw (local.get $imm)))

  ;; TEST [mem8], imm8
  (func $emit_test_m8_i (param $imm i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 138) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $imm)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 124) (local.get $imm))
    (call $te_raw (local.get $a)))

  ;; Shift [mem32]
  (func $emit_shift_m32 (param $shift_info i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 139) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (call $te_raw (local.get $shift_info)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 54) (local.get $shift_info))
    (call $te_raw (local.get $a)))

  ;; CALL [mem] (indirect)
  (func $emit_call_ind (param $ret_addr i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 140) (local.get $ret_addr))
            (call $te_raw (global.get $mr_base)) (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 40) (local.get $ret_addr))
    (call $te_raw (local.get $a)))

  ;; JMP [mem] (indirect)
  (func $emit_jmp_ind (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 141) (i32.const 0))
            (call $te_raw (global.get $mr_base)) (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 125) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; PUSH [mem32]
  (func $emit_push_m32 (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 142) (global.get $mr_base))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 121) (i32.const 0))
    (call $te_raw (local.get $a)))

  ;; MOVZX reg, byte [mem]
  (func $emit_movzx8 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 143) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 78) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVSX reg, byte [mem]
  (func $emit_movsx8 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 144) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 79) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVZX reg, word [mem]
  (func $emit_movzx16 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 145) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 80) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MOVSX reg, word [mem]
  (func $emit_movsx16 (param $dst i32) (local $a i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 146) (i32.or (i32.shl (local.get $dst) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    (local.set $a (call $emit_sib_or_abs))
    (call $te (i32.const 81) (local.get $dst))
    (call $te_raw (local.get $a)))

  ;; MUL/IMUL/DIV/IDIV [mem32]. type: 0=mul,1=imul,2=div,3=idiv
  (func $emit_muldiv_m32 (param $mtype i32)
    (if (call $mr_simple_base)
      (then (call $te (i32.const 147) (i32.or (i32.shl (local.get $mtype) (i32.const 4)) (global.get $mr_base)))
            (call $te_raw (global.get $mr_disp)) (return)))
    ;; Absolute: use existing handlers 60-63
    (if (i32.eq (local.get $mtype) (i32.const 0)) (then (call $te (i32.const 60) (i32.const 0)) (call $te_raw (global.get $mr_disp)) (return)))
    (if (i32.eq (local.get $mtype) (i32.const 1)) (then (call $te (i32.const 61) (i32.const 0)) (call $te_raw (global.get $mr_disp)) (return)))
    (if (i32.eq (local.get $mtype) (i32.const 2)) (then (call $te (i32.const 62) (i32.const 0)) (call $te_raw (global.get $mr_disp)) (return)))
    (call $te (i32.const 63) (i32.const 0)) (call $te_raw (global.get $mr_disp)))

  ;; ============================================================
  ;; DECODE BLOCK
  ;; ============================================================
  (func $decode_block (param $start_eip i32) (result i32)
    (local $tstart i32)
    (local $op i32)
    (local $done i32)
    (local $prefix_rep i32)    ;; 0=none, 1=REP/REPE, 2=REPNE
    (local $prefix_66 i32)     ;; operand-size override
    (local $prefix_seg i32)    ;; segment override (ignored but consumed)
    (local $imm i32)
    (local $disp i32)
    (local $a i32)

    (local.set $tstart (global.get $thread_alloc))
    (global.set $d_pc (local.get $start_eip))
    (local.set $done (i32.const 0))

    (block $exit (loop $decode
      (br_if $exit (local.get $done))

      ;; Reset prefixes
      (local.set $prefix_rep (i32.const 0))
      (local.set $prefix_66 (i32.const 0))
      (local.set $prefix_seg (i32.const 0))

      ;; Consume prefixes
      (block $pfx_done (loop $pfx
        (local.set $op (call $d_fetch8))
        (if (i32.eq (local.get $op) (i32.const 0xF3)) (then (local.set $prefix_rep (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0xF2)) (then (local.set $prefix_rep (i32.const 2)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x66)) (then (local.set $prefix_66 (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x26)) (then (local.set $prefix_seg (i32.const 1)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x2E)) (then (local.set $prefix_seg (i32.const 2)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x36)) (then (local.set $prefix_seg (i32.const 3)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x3E)) (then (local.set $prefix_seg (i32.const 4)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x64)) (then (local.set $prefix_seg (i32.const 5)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0x65)) (then (local.set $prefix_seg (i32.const 6)) (br $pfx)))
        (if (i32.eq (local.get $op) (i32.const 0xF0)) (then (br $pfx))) ;; LOCK — ignore
        (br $pfx_done)
      ))

      ;; Propagate segment prefix to global for ModRM decoder
      (global.set $d_seg (local.get $prefix_seg))

      ;; ---- NOP (0x90) ----
      (if (i32.eq (local.get $op) (i32.const 0x90)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode)))

      ;; ---- PUSH reg (0x50-0x57) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x50)) (i32.le_u (local.get $op) (i32.const 0x57)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 181) (i32.sub (local.get $op) (i32.const 0x50))))
          (else (call $te (i32.const 32) (i32.sub (local.get $op) (i32.const 0x50)))))
          (br $decode)))
      ;; ---- POP reg (0x58-0x5F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x58)) (i32.le_u (local.get $op) (i32.const 0x5F)))
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 182) (i32.sub (local.get $op) (i32.const 0x58))))
          (else (call $te (i32.const 33) (i32.sub (local.get $op) (i32.const 0x58)))))
          (br $decode)))
      ;; ---- INC reg (0x40-0x47) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x40)) (i32.le_u (local.get $op) (i32.const 0x47)))
        (then (call $te (i32.const 64) (i32.sub (local.get $op) (i32.const 0x40))) (br $decode)))
      ;; ---- DEC reg (0x48-0x4F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x48)) (i32.le_u (local.get $op) (i32.const 0x4F)))
        (then (call $te (i32.const 65) (i32.sub (local.get $op) (i32.const 0x48))) (br $decode)))
      ;; ---- MOV reg, imm32 (0xB8-0xBF) / MOV reg, imm16 with 0x66 ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xB8)) (i32.le_u (local.get $op) (i32.const 0xBF)))
        (then
          (call $te (i32.const 2) (i32.sub (local.get $op) (i32.const 0xB8)))
          (if (local.get $prefix_66)
            (then (call $te_raw (call $d_fetch16)))
            (else (call $te_raw (call $d_fetch32))))
          (br $decode)))
      ;; ---- MOV reg8, imm8 (0xB0-0xB7) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xB0)) (i32.le_u (local.get $op) (i32.const 0xB7)))
        (then
          (call $te (i32.const 156) (i32.sub (local.get $op) (i32.const 0xB0)))
          (call $te_raw (call $d_fetch8)) (br $decode)))
      ;; ---- XCHG eax, reg (0x91-0x97) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x91)) (i32.le_u (local.get $op) (i32.const 0x97)))
        (then (call $te (i32.const 116) (i32.sub (local.get $op) (i32.const 0x90))) (br $decode)))

      ;; ---- ALU r/m32, r32 (0x00-0x3F even: ADD=00,OR=08,ADC=10,SBB=18,AND=20,SUB=28,XOR=30,CMP=38) ----
      ;; Opcodes 0x00/0x01: ADD r/m, r (byte/dword)
      ;; 0x02/0x03: ADD r, r/m
      ;; Pattern: (op>>3)&7 = ALU index, bit 1 = direction (0=rm,r 1=r,rm), bit 0 = size (0=8 1=32)
      ;; This covers 0x00-0x3D (excluding 0x0F, and x6/x7/xE/xF = segment ops)
      (if (i32.and (i32.le_u (local.get $op) (i32.const 0x3D))
                   (i32.lt_u (i32.and (local.get $op) (i32.const 0x7)) (i32.const 6)))
        (then
          (local.set $imm (i32.and (i32.shr_u (local.get $op) (i32.const 3)) (i32.const 7))) ;; ALU op index
          ;; Check for AL/EAX, imm forms (bit pattern: xx100 = AL,imm8 and xx101 = EAX,imm32)
          (if (i32.eq (i32.and (local.get $op) (i32.const 7)) (i32.const 4))
            (then ;; AL, imm8 — byte ALU handler 154
              (call $te (i32.const 154) (i32.or (i32.shl (local.get $imm) (i32.const 8)) (i32.const 0))) ;; reg=AL(0)
              (call $te_raw (i32.and (call $d_fetch8) (i32.const 0xFF)))
              (br $decode)))
          (if (i32.eq (i32.and (local.get $op) (i32.const 7)) (i32.const 5))
            (then (if (local.get $prefix_66)
              (then ;; AX, imm16 — handler 207 (alu_r16_i16)
                (call $te (i32.const 207) (i32.shl (local.get $imm) (i32.const 4))) ;; reg=0(AX)
                (call $te_raw (i32.and (call $d_fetch16) (i32.const 0xFFFF))))
              (else ;; EAX, imm32
                (call $te (i32.add (i32.const 3) (local.get $imm)) (i32.const 0))
                (call $te_raw (call $d_fetch32))))
              (br $decode)))

          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              ;; reg, reg — check byte vs word vs dword
              (if (i32.and (local.get $op) (i32.const 1))
                (then (if (local.get $prefix_66)
                  (then ;; 16-bit: handler 206, op=alu<<8|dst<<4|src
                    (if (i32.and (local.get $op) (i32.const 2))
                      (then (call $te (i32.const 206)
                        (i32.or (i32.shl (local.get $imm) (i32.const 8))
                          (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))))
                      (else (call $te (i32.const 206)
                        (i32.or (i32.shl (local.get $imm) (i32.const 8))
                          (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))))
                  (else ;; 32-bit (odd opcode)
                    (if (i32.and (local.get $op) (i32.const 2))
                      (then (call $te (i32.add (i32.const 12) (local.get $imm))
                        (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                      (else (call $te (i32.add (i32.const 12) (local.get $imm))
                        (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))))
                (else ;; byte (even opcode) — use r8 handler 153
                  (if (i32.and (local.get $op) (i32.const 2))
                    (then (call $te (i32.const 153)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                        (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))))
                    (else (call $te (i32.const 153)
                      (i32.or (i32.shl (local.get $imm) (i32.const 8))
                        (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))))))
            (else
              ;; memory involved — use runtime EA helpers
              (if (i32.and (local.get $op) (i32.const 2))
                (then ;; r, [mem]
                  (if (i32.and (local.get $op) (i32.const 1))
                    (then (if (local.get $prefix_66)
                      (then (call $emit_alu_r16_m16 (local.get $imm) (global.get $mr_reg)))
                      (else (call $emit_alu_r_m32 (local.get $imm) (global.get $mr_reg)))))
                    (else (call $emit_alu_r_m8 (local.get $imm) (global.get $mr_reg)))))
                (else ;; [mem], r
                  (if (i32.and (local.get $op) (i32.const 1))
                    (then (if (local.get $prefix_66)
                      (then (call $emit_alu_m16_r16 (local.get $imm) (global.get $mr_reg)))
                      (else (call $emit_alu_m32_r (local.get $imm) (global.get $mr_reg)))))
                    (else (call $emit_alu_m8_r (local.get $imm) (global.get $mr_reg))))))))
          (br $decode)))

      ;; ---- 0x80/0x81/0x82/0x83: Group 1 — ALU r/m, imm ----
      (if (i32.or (i32.or (i32.eq (local.get $op) (i32.const 0x80)) (i32.eq (local.get $op) (i32.const 0x81)))
                  (i32.or (i32.eq (local.get $op) (i32.const 0x82)) (i32.eq (local.get $op) (i32.const 0x83))))
        (then
          (call $decode_modrm)
          ;; imm: 0x81=imm32 (or imm16 with 0x66), others=imm8 sign-extended
          (if (i32.eq (local.get $op) (i32.const 0x81))
            (then (if (local.get $prefix_66)
              (then (local.set $imm (call $d_fetch16)))
              (else (local.set $imm (call $d_fetch32)))))
            (else (local.set $imm (call $sign_ext8 (call $d_fetch8)))))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then ;; reg, imm
              (if (i32.or (i32.eq (local.get $op) (i32.const 0x80)) (i32.eq (local.get $op) (i32.const 0x82)))
                (then ;; byte reg, imm8 — handler 154
                  (call $te (i32.const 154) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (global.get $mr_val)))
                  (call $te_raw (local.get $imm)))
                (else (if (i32.and (local.get $prefix_66) (i32.or (i32.eq (local.get $op) (i32.const 0x81)) (i32.eq (local.get $op) (i32.const 0x83))))
                  (then ;; 16-bit reg, imm16 — handler 207
                    (call $te (i32.const 207) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                    (call $te_raw (local.get $imm)))
                  (else ;; dword reg, imm32
                    (call $te (i32.add (i32.const 3) (global.get $mr_reg)) (global.get $mr_val))
                    (call $te_raw (local.get $imm)))))))
            (else ;; [mem], imm — use runtime EA
              (if (i32.or (i32.eq (local.get $op) (i32.const 0x80)) (i32.eq (local.get $op) (i32.const 0x82)))
                (then (call $emit_alu_m8_i (global.get $mr_reg) (local.get $imm)))
                (else (if (local.get $prefix_66)
                  (then (call $emit_alu_m16_i (global.get $mr_reg) (local.get $imm)))
                  (else (call $emit_alu_m32_i (global.get $mr_reg) (local.get $imm))))))))
          (br $decode)))

      ;; ---- 0x84: TEST r/m8, r8 ----
      (if (i32.eq (local.get $op) (i32.const 0x84))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 150) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
            (else (call $emit_test_m8_r (global.get $mr_reg))))
          (br $decode)))

      ;; ---- 0x85: TEST r/m32, r (or r/m16, r16 with 0x66) ----
      (if (i32.eq (local.get $op) (i32.const 0x85))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (if (local.get $prefix_66)
              (then (call $te (i32.const 204) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
              (else (call $te (i32.const 72) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))
            (else (call $emit_test_m32_r (global.get $mr_reg))))
          (br $decode)))

      ;; ---- 0x88/0x89: MOV r/m, r ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x88)) (i32.eq (local.get $op) (i32.const 0x89)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (local.get $op) (i32.const 0x88))
                (then (call $te (i32.const 155) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                (else (if (local.get $prefix_66)
                  (then (call $te (i32.const 210) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
                  (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x89))
                (then (if (local.get $prefix_66)
                  (then (call $emit_store16 (global.get $mr_reg)))
                  (else (call $emit_store32 (global.get $mr_reg)))))
                (else (call $emit_store8 (global.get $mr_reg))))))
          (br $decode)))

      ;; ---- 0x8A/0x8B: MOV r, r/m ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x8A)) (i32.eq (local.get $op) (i32.const 0x8B)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (local.get $op) (i32.const 0x8A))
                (then (call $te (i32.const 155) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (if (local.get $prefix_66)
                  (then (call $te (i32.const 210) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                  (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x8B))
                (then (if (local.get $prefix_66)
                  (then (call $emit_load16 (global.get $mr_reg)))
                  (else (call $emit_load32 (global.get $mr_reg)))))
                (else (call $emit_load8 (global.get $mr_reg))))))
          (br $decode)))

      ;; ---- 0x8D: LEA ----
      (if (i32.eq (local.get $op) (i32.const 0x8D))
        (then
          (call $decode_modrm)
          (call $emit_lea (global.get $mr_reg))
          (br $decode)))

      ;; ---- 0xA0-0xA3: MOV AL/EAX, [abs] / MOV [abs], AL/EAX ----
      ;; Apply FS base if segment override is active
      (if (i32.eq (local.get $op) (i32.const 0xA0)) (then (call $te (i32.const 24) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA1)) (then
        (if (local.get $prefix_66)
          (then (call $te (i32.const 164) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))))  ;; mov ax, [addr]
          (else (call $te (i32.const 20) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg)))))   ;; mov eax, [addr]
        (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA2)) (then (call $te (i32.const 25) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA3)) (then
        (if (local.get $prefix_66)
          (then (call $te (i32.const 163) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))))  ;; mov [addr], ax
          (else (call $te (i32.const 21) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg)))))   ;; mov [addr], eax
        (br $decode)))

      ;; ---- 0xC6: MOV r/m8, imm8 ----
      (if (i32.eq (local.get $op) (i32.const 0xC6))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 2) (global.get $mr_val)) (call $te_raw (local.get $imm)))
            (else (call $emit_store8_imm (local.get $imm))))
          (br $decode)))

      ;; ---- 0xC7: MOV r/m32, imm32 (or r/m16, imm16 with 66 prefix) ----
      (if (i32.eq (local.get $op) (i32.const 0xC7))
        (then
          (call $decode_modrm)
          (if (local.get $prefix_66)
            (then (local.set $imm (call $d_fetch16)))
            (else (local.set $imm (call $d_fetch32))))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 2) (global.get $mr_val)) (call $te_raw (local.get $imm)))
            (else (if (local.get $prefix_66)
              (then (call $emit_store16_imm (local.get $imm)))
              (else (call $emit_store32_imm (local.get $imm))))))
          (br $decode)))

      ;; ---- 0xA8: TEST AL, imm8 ----
      (if (i32.eq (local.get $op) (i32.const 0xA8))
        (then (call $te (i32.const 73) (i32.const 0)) (call $te_raw (call $sign_ext8 (call $d_fetch8))) (br $decode)))
      ;; ---- 0xA9: TEST EAX, imm32 ----
      (if (i32.eq (local.get $op) (i32.const 0xA9))
        (then (call $te (i32.const 73) (i32.const 0)) (call $te_raw (call $d_fetch32)) (br $decode)))

      ;; ---- 0xF6/0xF7: Unary group 3 ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xF6)) (i32.eq (local.get $op) (i32.const 0xF7)))
        (then
          (call $decode_modrm)
          ;; mr_reg: 0=TEST,1=TEST,2=NOT,3=NEG,4=MUL,5=IMUL,6=DIV,7=IDIV
          (if (i32.le_u (global.get $mr_reg) (i32.const 1)) ;; TEST
            (then
              (if (i32.eq (local.get $op) (i32.const 0xF7))
                (then (local.set $imm (call $d_fetch32)))
                (else (local.set $imm (call $d_fetch8))))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 73) (global.get $mr_val)) (call $te_raw (local.get $imm)))
                (else
                  (if (i32.eq (local.get $op) (i32.const 0xF7))
                    (then (call $emit_test_m32_i (local.get $imm)))
                    (else (call $emit_test_m8_i (local.get $imm))))))

              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 2)) ;; NOT
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 66) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 2))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 3)) ;; NEG
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 67) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 3))))
              (br $decode)))
          ;; MUL/IMUL/DIV/IDIV
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              (if (i32.eq (global.get $mr_reg) (i32.const 4)) (then (call $te (i32.const 55) (global.get $mr_val))))
              (if (i32.eq (global.get $mr_reg) (i32.const 5)) (then (call $te (i32.const 56) (global.get $mr_val))))
              (if (i32.eq (global.get $mr_reg) (i32.const 6)) (then (call $te (i32.const 57) (global.get $mr_val))))
              (if (i32.eq (global.get $mr_reg) (i32.const 7)) (then (call $te (i32.const 58) (global.get $mr_val)))))
            (else
              (if (i32.eq (global.get $mr_reg) (i32.const 4)) (then (call $emit_muldiv_m32 (i32.const 0))))
              (if (i32.eq (global.get $mr_reg) (i32.const 5)) (then (call $emit_muldiv_m32 (i32.const 1))))
              (if (i32.eq (global.get $mr_reg) (i32.const 6)) (then (call $emit_muldiv_m32 (i32.const 2))))
              (if (i32.eq (global.get $mr_reg) (i32.const 7)) (then (call $emit_muldiv_m32 (i32.const 3))))))
          (br $decode)))

      ;; ---- 0xFE/0xFF: Group 4/5 (INC/DEC/CALL/JMP/PUSH r/m) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xFE)) (i32.eq (local.get $op) (i32.const 0xFF)))
        (then
          (call $decode_modrm)
          ;; 0=INC, 1=DEC, 2=CALL, 3=CALL far, 4=JMP, 5=JMP far, 6=PUSH
          (if (i32.eq (global.get $mr_reg) (i32.const 0)) ;; INC
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 64) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 0))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 1)) ;; DEC
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 65) (global.get $mr_val)))
                (else (call $emit_unary_m32 (i32.const 1))))
              (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 2)) ;; CALL r/m32
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 119) (global.get $d_pc))
                      (call $te_raw (global.get $mr_val)))
                (else (call $emit_call_ind (global.get $d_pc))))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 4)) ;; JMP r/m32
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 120) (global.get $mr_val)))
                (else (call $emit_jmp_ind)))
              (local.set $done (i32.const 1)) (br $decode)))
          (if (i32.eq (global.get $mr_reg) (i32.const 6)) ;; PUSH r/m32
            (then
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 32) (global.get $mr_val)))
                (else (call $emit_push_m32)))
              (br $decode)))
          ;; Unhandled FF variant
          (call $te (i32.const 45) (global.get $d_pc))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- 0xD0-0xD3: Shift group 2 ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xD0)) (i32.le_u (local.get $op) (i32.const 0xD3)))
        (then
          (call $decode_modrm)
          ;; D0=rm8,1  D1=rm32,1  D2=rm8,CL  D3=rm32,CL
          (local.set $imm (if (result i32) (i32.or (i32.eq (local.get $op) (i32.const 0xD0)) (i32.eq (local.get $op) (i32.const 0xD1)))
            (then (i32.const 1)) (else (i32.const 0xFF)))) ;; 0xFF = use CL
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xD0)) (i32.eq (local.get $op) (i32.const 0xD2)))
            (then ;; 8-bit shifts
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 191) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                (else (call $te (i32.const 192) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
            (else (if (local.get $prefix_66)
              (then ;; 16-bit shifts
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 193) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $te (i32.const 194) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
              (else ;; 32-bit shifts
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))))))
          (br $decode)))

      ;; ---- 0xC0/0xC1: Shift group 2, imm8 ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xC0)) (i32.eq (local.get $op) (i32.const 0xC1)))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (local.get $op) (i32.const 0xC0))
            (then ;; 8-bit shift
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 191) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                (else (call $te (i32.const 192) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
            (else (if (local.get $prefix_66)
              (then ;; 16-bit shift
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 193) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $te (i32.const 194) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16)))) (call $te_raw (call $emit_sib_or_abs)))))
              (else ;; 32-bit shift
                (if (i32.eq (global.get $mr_mod) (i32.const 3))
                  (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
                  (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))))))
          (br $decode)))

      ;; ---- PUSH imm32 (0x68) / PUSH imm8 (0x6A) ----
      (if (i32.eq (local.get $op) (i32.const 0x68))
        (then (call $te (i32.const 34) (i32.const 0))
          (if (local.get $prefix_66)
            (then (call $te_raw (call $d_fetch16)))
            (else (call $te_raw (call $d_fetch32))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0x6A)) (then (call $te (i32.const 34) (i32.const 0)) (call $te_raw (call $sign_ext8 (call $d_fetch8))) (br $decode)))

      ;; ---- IMUL r32, r/m32, imm (0x69/0x6B) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x69)) (i32.eq (local.get $op) (i32.const 0x6B)))
        (then
          (call $decode_modrm)
          (if (i32.eq (local.get $op) (i32.const 0x69))
            (then (local.set $imm (call $d_fetch32)))
            (else (local.set $imm (call $sign_ext8 (call $d_fetch8)))))
          ;; For reg,reg: emit imul_r_r_i
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 59) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                  (call $te_raw (local.get $imm)))
            (else ;; reg, [mem], imm — load then multiply
              (call $emit_load32 (global.get $mr_reg))
              (call $te (i32.const 59) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_reg)))
              (call $te_raw (local.get $imm))))
          (br $decode)))

      ;; ---- CALL rel32 (0xE8) ----
      (if (i32.eq (local.get $op) (i32.const 0xE8))
        (then
          (local.set $disp (call $d_fetch32))
          (call $te (i32.const 39) (global.get $d_pc))
          (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- RET (0xC3) ----
      (if (i32.eq (local.get $op) (i32.const 0xC3)) (then (call $te (i32.const 41) (i32.const 0)) (local.set $done (i32.const 1)) (br $decode)))
      ;; ---- RET imm16 (0xC2) ----
      (if (i32.eq (local.get $op) (i32.const 0xC2)) (then (call $te (i32.const 42) (call $d_fetch16)) (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- JMP rel8 (0xEB) / JMP rel32 (0xE9) ----
      (if (i32.eq (local.get $op) (i32.const 0xEB))
        (then (local.set $disp (call $sign_ext8 (call $d_fetch8)))
              (call $te (i32.const 43) (i32.const 0)) (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xE9))
        (then (local.set $disp (call $d_fetch32))
              (call $te (i32.const 43) (i32.const 0)) (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- Jcc rel8 (0x70-0x7F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x70)) (i32.le_u (local.get $op) (i32.const 0x7F)))
        (then
          (local.set $disp (call $sign_ext8 (call $d_fetch8)))
          (call $te (i32.const 44) (i32.and (local.get $op) (i32.const 0xF)))
          (call $te_raw (global.get $d_pc)) ;; fall-through
          (call $te_raw (i32.add (global.get $d_pc) (local.get $disp))) ;; target
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- LOOP/LOOPE/LOOPNE (0xE0-0xE2) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xE0)) (i32.le_u (local.get $op) (i32.const 0xE2)))
        (then
          (local.set $disp (call $sign_ext8 (call $d_fetch8)))
          ;; E2=LOOP, E1=LOOPE, E0=LOOPNE
          (local.set $imm (i32.sub (i32.const 0xE2) (local.get $op))) ;; 0=LOOP, 1=LOOPE, 2=LOOPNE
          (call $te (i32.const 46) (local.get $imm))
          (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
          (call $te_raw (global.get $d_pc))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- String ops ----
      (if (i32.eq (local.get $op) (i32.const 0xA4)) ;; MOVSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 82) (i32.const 0))) (else (call $te (i32.const 86) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA5)) ;; MOVSD / MOVSW
        (then (if (local.get $prefix_66)
          (then (if (local.get $prefix_rep) (then (call $te (i32.const 186) (i32.const 0))) (else (call $te (i32.const 183) (i32.const 0)))))
          (else (if (local.get $prefix_rep) (then (call $te (i32.const 83) (i32.const 0))) (else (call $te (i32.const 87) (i32.const 0))))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAA)) ;; STOSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 84) (i32.const 0))) (else (call $te (i32.const 88) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAB)) ;; STOSD / STOSW
        (then (if (local.get $prefix_66)
          (then (if (local.get $prefix_rep) (then (call $te (i32.const 187) (i32.const 0))) (else (call $te (i32.const 184) (i32.const 0)))))
          (else (if (local.get $prefix_rep) (then (call $te (i32.const 85) (i32.const 0))) (else (call $te (i32.const 89) (i32.const 0))))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAC)) ;; LODSB
        (then (call $te (i32.const 90) (i32.const 0)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAD)) ;; LODSD / LODSW
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 185) (i32.const 0)))
          (else (call $te (i32.const 91) (i32.const 0))))
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA6)) ;; CMPSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 92) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 94) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA7)) ;; CMPSD
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 169) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 171) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAE)) ;; SCASB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 93) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 95) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAF)) ;; SCASD
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 170) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 172) (i32.const 0)))) (br $decode)))

      ;; ---- Misc single-byte ----
      (if (i32.eq (local.get $op) (i32.const 0x60)) (then (call $te (i32.const 35) (i32.const 0)) (br $decode))) ;; PUSHAD
      (if (i32.eq (local.get $op) (i32.const 0x61)) (then (call $te (i32.const 36) (i32.const 0)) (br $decode))) ;; POPAD
      (if (i32.eq (local.get $op) (i32.const 0x9C)) (then (call $te (i32.const 37) (i32.const 0)) (br $decode))) ;; PUSHFD
      (if (i32.eq (local.get $op) (i32.const 0x9D)) (then (call $te (i32.const 38) (i32.const 0)) (br $decode))) ;; POPFD
      (if (i32.eq (local.get $op) (i32.const 0x99)) ;; CDQ / CWD
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 180) (i32.const 0)))  ;; CWD
          (else (call $te (i32.const 105) (i32.const 0)))) ;; CDQ
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0x98)) ;; CWDE / CBW
        (then (if (local.get $prefix_66)
          (then (call $te (i32.const 106) (i32.const 0)))  ;; CBW
          (else (call $te (i32.const 107) (i32.const 0)))) ;; CWDE
          (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xFC)) (then (call $te (i32.const 108) (i32.const 0)) (br $decode))) ;; CLD
      (if (i32.eq (local.get $op) (i32.const 0xFD)) (then (call $te (i32.const 109) (i32.const 0)) (br $decode))) ;; STD
      (if (i32.eq (local.get $op) (i32.const 0xF8)) (then (call $te (i32.const 110) (i32.const 0)) (br $decode))) ;; CLC
      (if (i32.eq (local.get $op) (i32.const 0xF9)) (then (call $te (i32.const 111) (i32.const 0)) (br $decode))) ;; STC
      (if (i32.eq (local.get $op) (i32.const 0xF5)) (then (call $te (i32.const 112) (i32.const 0)) (br $decode))) ;; CMC
      (if (i32.eq (local.get $op) (i32.const 0xC9)) (then (call $te (i32.const 113) (i32.const 0)) (br $decode))) ;; LEAVE
      (if (i32.eq (local.get $op) (i32.const 0xCC)) (then (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; INT3
      (if (i32.eq (local.get $op) (i32.const 0xCD)) (then (drop (call $d_fetch8)) (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; INT imm8
      (if (i32.eq (local.get $op) (i32.const 0xF4)) (then (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)) (br $decode))) ;; HLT
      ;; CLI/STI — ignore (no interrupt emulation)
      (if (i32.eq (local.get $op) (i32.const 0xFA)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode))) ;; CLI
      (if (i32.eq (local.get $op) (i32.const 0xFB)) (then (call $te (i32.const 0) (i32.const 0)) (br $decode))) ;; STI

      ;; ---- 0x8F: POP r/m32 (/0) ----
      (if (i32.eq (local.get $op) (i32.const 0x8F))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 33) (global.get $mr_val)))
            (else ;; POP to memory — load from stack, store to mem
              (call $te (i32.const 20) (i32.const 0)) ;; load32 eax from [esp]
              (call $te_raw (global.get $esp))         ;; but esp is dynamic... this won't work
              ;; Just end block for this rare case
              (call $te (i32.const 45) (i32.sub (global.get $d_pc) (i32.const 2)))))
          (br $decode)))

      ;; ---- 0x0F: Two-byte opcodes ----
      (if (i32.eq (local.get $op) (i32.const 0x0F))
        (then
          (local.set $op (call $d_fetch8))

          ;; 0x0F 0x80-0x8F: Jcc rel32
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x80)) (i32.le_u (local.get $op) (i32.const 0x8F)))
            (then
              (local.set $disp (call $d_fetch32))
              (call $te (i32.const 44) (i32.and (local.get $op) (i32.const 0xF)))
              (call $te_raw (global.get $d_pc))
              (call $te_raw (i32.add (global.get $d_pc) (local.get $disp)))
              (local.set $done (i32.const 1)) (br $decode)))

          ;; 0x0F 0x90-0x9F: SETcc r/m8
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x90)) (i32.le_u (local.get $op) (i32.const 0x9F)))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $te (i32.const 102) (i32.and (local.get $op) (i32.const 0xF)))
                  (call $te_raw (global.get $mr_val)))
                (else
                  (call $te (i32.const 211) (i32.and (local.get $op) (i32.const 0xF)))
                  (call $te_raw (global.get $mr_disp))))
              (br $decode)))

          ;; 0x0F 0xA3: BT r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xA3))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 198) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))
          ;; 0x0F 0xAB: BTS r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xAB))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 199) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))
          ;; 0x0F 0xB3: BTR r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xB3))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 200) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))
          ;; 0x0F 0xBB: BTC r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xBB))
            (then (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 201) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
              (br $decode)))

          ;; 0x0F 0xAF: IMUL r32, r/m32
          (if (i32.eq (local.get $op) (i32.const 0xAF))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 118) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else ;; imul reg, [mem] — dedicated opcodes to avoid clobbering dst
                  (if (call $mr_simple_base)
                    (then (call $te (i32.const 157) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                          (call $te_raw (global.get $mr_disp)))
                    (else (local.set $imm (call $emit_sib_or_abs))
                          (call $te (i32.const 158) (global.get $mr_reg))
                          (call $te_raw (local.get $imm))))))
              (br $decode)))

          ;; 0x0F 0xB6: MOVZX r32, r/m8
          (if (i32.eq (local.get $op) (i32.const 0xB6))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then ;; movzx r32, reg8 — handler 208
                  (call $te (i32.const 208) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movzx8 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xB7: MOVZX r32, r/m16
          (if (i32.eq (local.get $op) (i32.const 0xB7))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                      (call $te (i32.const 7) (global.get $mr_reg)) (call $te_raw (i32.const 0xFFFF)))
                (else (call $emit_movzx16 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xBE: MOVSX r32, r/m8
          (if (i32.eq (local.get $op) (i32.const 0xBE))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then ;; movsx r32, reg8 — handler 209
                  (call $te (i32.const 209) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                (else (call $emit_movsx8 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xBF: MOVSX r32, r/m16
          (if (i32.eq (local.get $op) (i32.const 0xBF))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                  (call $te (i32.const 53) (i32.or (global.get $mr_reg) (i32.or (i32.shl (i32.const 4) (i32.const 8)) (i32.shl (i32.const 16) (i32.const 16)))))
                  (call $te (i32.const 53) (i32.or (global.get $mr_reg) (i32.or (i32.shl (i32.const 7) (i32.const 8)) (i32.shl (i32.const 16) (i32.const 16))))))
                (else (call $emit_movsx16 (global.get $mr_reg))))
              (br $decode)))

          ;; 0x0F 0xA4/0xA5: SHLD, 0x0F 0xAC/0xAD: SHRD
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xA4)) (i32.eq (local.get $op) (i32.const 0xA5)))
            (then
              (call $decode_modrm)
              (if (i32.eq (local.get $op) (i32.const 0xA4))
                (then (local.set $imm (call $d_fetch8)))
                (else (local.set $imm (i32.and (global.get $ecx) (i32.const 31)))))
              (call $te (i32.const 103) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
              (call $te_raw (local.get $imm)) (br $decode)))
          (if (i32.or (i32.eq (local.get $op) (i32.const 0xAC)) (i32.eq (local.get $op) (i32.const 0xAD)))
            (then
              (call $decode_modrm)
              (if (i32.eq (local.get $op) (i32.const 0xAC))
                (then (local.set $imm (call $d_fetch8)))
                (else (local.set $imm (i32.and (global.get $ecx) (i32.const 31)))))
              (call $te (i32.const 104) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))
              (call $te_raw (local.get $imm)) (br $decode)))

          ;; 0x0F 0xBA: BT/BTS/BTR/BTC r/m32, imm8
          (if (i32.eq (local.get $op) (i32.const 0xBA))
            (then
              (call $decode_modrm)
              (local.set $imm (call $d_fetch8))
              ;; mr_reg: 4=BT, 5=BTS, 6=BTR, 7=BTC
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then
                  (call $te (i32.add (i32.const 92) (global.get $mr_reg)) (global.get $mr_val)) ;; 96-99
                  (call $te_raw (local.get $imm)))
                (else
                  ;; Memory BT/BTS/BTR/BTC: mr_reg 4=BT,5=BTS,6=BTR,7=BTC → handler 176-179
                  (call $te (i32.add (i32.const 172) (global.get $mr_reg)) (i32.const 0))
                  (call $te_raw (call $emit_sib_or_abs))
                  (call $te_raw (local.get $imm))))
              (br $decode)))

          ;; 0x0F 0xBC: BSF, 0x0F 0xBD: BSR
          (if (i32.eq (local.get $op) (i32.const 0xBC))
            (then (call $decode_modrm) (call $te (i32.const 100) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))) (br $decode)))
          (if (i32.eq (local.get $op) (i32.const 0xBD))
            (then (call $decode_modrm) (call $te (i32.const 101) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))) (br $decode)))

          ;; 0x0F 0xC8-0xCF: BSWAP reg
          (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xC8)) (i32.le_u (local.get $op) (i32.const 0xCF)))
            (then (call $te (i32.const 115) (i32.sub (local.get $op) (i32.const 0xC8))) (br $decode)))

          ;; 0x0F 0x1F: multi-byte NOP (NOP r/m32)
          (if (i32.eq (local.get $op) (i32.const 0x1F))
            (then (call $decode_modrm) (call $te (i32.const 0) (i32.const 0)) (br $decode)))

          ;; 0x0F 0x31: RDTSC — stub (return 0 in edx:eax)
          (if (i32.eq (local.get $op) (i32.const 0x31))
            (then (call $te (i32.const 2) (i32.const 0)) (call $te_raw (i32.const 0))
                  (call $te (i32.const 2) (i32.const 2)) (call $te_raw (i32.const 0)) (br $decode)))

          ;; 0x0F 0xB1: CMPXCHG r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xB1))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 173) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                (else (call $te (i32.const 173) (global.get $mr_reg)) (call $te_raw (call $emit_sib_or_abs))))
              (br $decode)))

          ;; 0x0F 0xC1: XADD r/m32, r32
          (if (i32.eq (local.get $op) (i32.const 0xC1))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te (i32.const 174) (i32.or (i32.const 0x80) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
                (else (call $te (i32.const 174) (global.get $mr_reg)) (call $te_raw (call $emit_sib_or_abs))))
              (br $decode)))

          ;; 0x0F 0xC7: CMPXCHG8B m64 (ModRM reg field must be 1)
          (if (i32.eq (local.get $op) (i32.const 0xC7))
            (then
              (call $decode_modrm)
              (if (i32.eq (global.get $mr_reg) (i32.const 1))
                (then (call $te (i32.const 195) (i32.const 0)) (call $te_raw (call $emit_sib_or_abs))))
              (br $decode)))

          ;; 0x0F 0xA2: CPUID
          (if (i32.eq (local.get $op) (i32.const 0xA2))
            (then (call $te (i32.const 175) (i32.const 0)) (br $decode)))

          ;; Unknown 0x0F xx
          (call $host_log_i32 (i32.or (i32.const 0x0F00) (local.get $op)))
          (call $te (i32.const 45) (i32.sub (global.get $d_pc) (i32.const 2)))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- XCHG r/m32, r32 (0x87) / XCHG r/m8 (0x86) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x86)) (i32.eq (local.get $op) (i32.const 0x87)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 71) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
            (else (if (call $mr_simple_base)
              (then (call $te (i32.const 197) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_base)))
                    (call $te_raw (global.get $mr_disp)))
              (else (call $te (i32.const 196) (global.get $mr_reg))
                    (call $te_raw (call $emit_sib_or_abs))))))
          (br $decode)))

      ;; ---- FWAIT (0x9B) — NOP, wait for FPU exceptions (we don't generate any) ----
      (if (i32.eq (local.get $op) (i32.const 0x9B))
        (then (br $decode)))

      ;; ---- x87 FPU (D8-DF) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0xD8)) (i32.le_u (local.get $op) (i32.const 0xDF)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              ;; Register-register: emit th_fpu_reg (189) with (group<<8)|(reg<<4)|rm
              (call $te (i32.const 189) (i32.or (i32.or
                (i32.shl (i32.sub (local.get $op) (i32.const 0xD8)) (i32.const 8))
                (i32.shl (global.get $mr_reg) (i32.const 4)))
                (global.get $mr_val))))
            (else
              ;; Memory operand
              (call $apply_seg_override)
              (if (call $mr_simple_base)
                (then
                  ;; base+disp: emit th_fpu_mem_ro (190) with (group<<8)|(reg<<4)|base, disp
                  (call $te (i32.const 190) (i32.or (i32.or
                    (i32.shl (i32.sub (local.get $op) (i32.const 0xD8)) (i32.const 8))
                    (i32.shl (global.get $mr_reg) (i32.const 4)))
                    (global.get $mr_base)))
                  (call $te_raw (global.get $mr_disp)))
                (else
                  ;; absolute or SIB: use emit_sib_or_abs
                  (local.set $a (call $emit_sib_or_abs))
                  (call $te (i32.const 188) (i32.or
                    (i32.shl (i32.sub (local.get $op) (i32.const 0xD8)) (i32.const 4))
                    (global.get $mr_reg)))
                  (call $te_raw (local.get $a))))))
          ;; FPU instructions do NOT end blocks — continue decoding
          (br $decode)))

      ;; ---- Unrecognized opcode ----
      (call $host_log_i32 (local.get $op))
      (call $te (i32.const 45) (i32.sub (global.get $d_pc) (i32.const 1)))
      (local.set $done (i32.const 1))
      (br $decode)
    ))

    (call $cache_store (local.get $start_eip) (local.get $tstart))
    (local.get $tstart)
  )

  ;; ============================================================
  ;; PE LOADER
  ;; ============================================================
  (func $load_pe (export "load_pe") (param $size i32) (result i32)
    (local $pe_off i32) (local $num_sections i32) (local $opt_hdr_size i32)
    (local $section_off i32) (local $i i32) (local $vaddr i32) (local $vsize i32)
    (local $raw_off i32) (local $raw_size i32) (local $import_rva i32)
    (local $src i32) (local $dst i32) (local $characteristics i32)

    (if (i32.ne (i32.load16_u (global.get $PE_STAGING)) (i32.const 0x5A4D)) (then (return (i32.const -1))))
    (local.set $pe_off (i32.add (global.get $PE_STAGING)
      (i32.load (i32.add (global.get $PE_STAGING) (i32.const 0x3C)))))
    (if (i32.ne (i32.load (local.get $pe_off)) (i32.const 0x00004550)) (then (return (i32.const -2))))

    (local.set $num_sections (i32.load16_u (i32.add (local.get $pe_off) (i32.const 6))))
    (local.set $opt_hdr_size (i32.load16_u (i32.add (local.get $pe_off) (i32.const 20))))
    (global.set $image_base (i32.load (i32.add (local.get $pe_off) (i32.const 52))))
    (global.set $entry_point (i32.add (global.get $image_base) (i32.load (i32.add (local.get $pe_off) (i32.const 40)))))
    ;; Compute guest-space thunk zone bounds
    (global.set $thunk_guest_base (i32.add (i32.sub (global.get $THUNK_BASE) (global.get $GUEST_BASE)) (global.get $image_base)))
    (global.set $thunk_guest_end  (i32.add (i32.sub (global.get $THUNK_END)  (global.get $GUEST_BASE)) (global.get $image_base)))
    (local.set $import_rva (i32.load (i32.add (local.get $pe_off) (i32.const 128))))
    ;; Resource directory RVA = data directory entry 2 (offset 136 in optional header)
    (global.set $rsrc_rva (i32.load (i32.add (local.get $pe_off) (i32.const 136))))

    ;; Store SizeOfImage for DLL loader
    (global.set $exe_size_of_image (i32.load (i32.add (local.get $pe_off) (i32.const 80))))
    ;; Set heap to be above the image
    (global.set $heap_ptr (i32.add (global.get $image_base) (global.get $exe_size_of_image)))

    (local.set $section_off (i32.add (local.get $pe_off) (i32.add (i32.const 24) (local.get $opt_hdr_size))))
    (local.set $i (i32.const 0))
    (block $sd (loop $sl
      (br_if $sd (i32.ge_u (local.get $i) (local.get $num_sections)))
      (local.set $vsize (i32.load (i32.add (local.get $section_off) (i32.const 8))))
      (local.set $vaddr (i32.load (i32.add (local.get $section_off) (i32.const 12))))
      (local.set $raw_size (i32.load (i32.add (local.get $section_off) (i32.const 16))))
      (local.set $raw_off (i32.load (i32.add (local.get $section_off) (i32.const 20))))
      (local.set $characteristics (i32.load (i32.add (local.get $section_off) (i32.const 36))))
      (local.set $dst (i32.add (global.get $GUEST_BASE) (local.get $vaddr)))
      (local.set $src (i32.add (global.get $PE_STAGING) (local.get $raw_off)))
      (call $memcpy (local.get $dst) (local.get $src) (local.get $raw_size))
      ;; Zero BSS portion: if VirtualSize > RawSize, zero the remainder
      (if (i32.gt_u (local.get $vsize) (local.get $raw_size))
        (then (call $zero_memory
          (i32.add (local.get $dst) (local.get $raw_size))
          (i32.sub (local.get $vsize) (local.get $raw_size)))))
      (if (i32.and (local.get $characteristics) (i32.const 0x20))
        (then
          (global.set $code_start (i32.add (global.get $image_base) (local.get $vaddr)))
          (global.set $code_end (i32.add (global.get $code_start) (local.get $vsize)))))
      (local.set $section_off (i32.add (local.get $section_off) (i32.const 40)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sl)))

    (if (i32.ne (local.get $import_rva) (i32.const 0))
      (then (call $process_imports (local.get $import_rva))))

    (global.set $eip (global.get $entry_point))
    ;; ESP must be a guest address: GUEST_STACK(WASM) → guest = WASM - GUEST_BASE + image_base
    (global.set $esp (i32.add (i32.sub (global.get $GUEST_STACK) (global.get $GUEST_BASE)) (global.get $image_base)))
    (global.set $eax (i32.const 0)) (global.set $ecx (i32.const 0))
    (global.set $edx (i32.const 0)) (global.set $ebx (i32.const 0))
    (global.set $ebp (i32.const 0)) (global.set $esi (i32.const 0))
    (global.set $edi (i32.const 0)) (global.set $df (i32.const 0))
    ;; Allocate fake TIB (Thread Information Block) for FS segment
    (global.set $fs_base (call $heap_alloc (i32.const 256)))
    (call $zero_memory (call $g2w (global.get $fs_base)) (i32.const 256))
    ;; TIB+0: SEH chain head (set to -1 = end of chain)
    (call $gs32 (global.get $fs_base) (i32.const 0xFFFFFFFF))
    ;; TIB+0x18: Self-pointer (linear address of TIB)
    (call $gs32 (i32.add (global.get $fs_base) (i32.const 0x18)) (global.get $fs_base))
    ;; TIB+0x04: Stack top
    (call $gs32 (i32.add (global.get $fs_base) (i32.const 0x04)) (global.get $esp))
    ;; TIB+0x08: Stack bottom (1MB below top)
    (call $gs32 (i32.add (global.get $fs_base) (i32.const 0x08)) (i32.sub (global.get $esp) (i32.const 0x100000)))
    (global.get $entry_point))

  ;; ============================================================
  ;; IMPORT TABLE
  ;; ============================================================
  (func $process_imports (param $import_rva i32)
    (local $desc_ptr i32) (local $ilt_rva i32) (local $iat_rva i32)
    (local $ilt_ptr i32) (local $iat_ptr i32) (local $entry i32) (local $thunk_addr i32)
    (local.set $desc_ptr (i32.add (global.get $GUEST_BASE) (local.get $import_rva)))
    (block $id (loop $dl
      (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
      (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))
      (br_if $id (i32.eqz (local.get $ilt_rva)))
      (local.set $ilt_ptr (i32.add (global.get $GUEST_BASE) (local.get $ilt_rva)))
      (local.set $iat_ptr (i32.add (global.get $GUEST_BASE) (local.get $iat_rva)))
      (block $fd (loop $fl
        (local.set $entry (i32.load (local.get $ilt_ptr)))
        (br_if $fd (i32.eqz (local.get $entry)))
        ;; WASM addr of thunk data = THUNK_BASE + idx*8
        ;; Guest addr = WASM_addr - GUEST_BASE + image_base
        (local.set $thunk_addr (i32.add
          (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                   (global.get $GUEST_BASE))
          (global.get $image_base)))
        (i32.store (local.get $iat_ptr) (local.get $thunk_addr))
        (if (i32.eqz (i32.and (local.get $entry) (i32.const 0x80000000)))
          (then
            (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (local.get $entry))
            ;; Lookup and store API ID in thunk+4
            (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
              (call $lookup_api_id (i32.add (global.get $GUEST_BASE) (i32.add (local.get $entry) (i32.const 2)))))))
        (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
        (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
        (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
        (br $fl)))
      (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
      (br $dl)))

    ;; Allocate catch-return thunk: guest addr for catch funclet return
    ;; Write a special marker (0xCACA0000) as the name RVA so win32_dispatch can identify it
    (global.set $catch_ret_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0000))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
  )

  ;; ============================================================
  ;; DLL LOADER — Load PE DLLs into guest address space
  ;; ============================================================
  ;; DLL_TABLE layout at 0xE63000: 32 bytes per DLL, max 16 DLLs = 512 bytes
  ;; +0:  load_addr (guest)
  ;; +4:  size_of_image
  ;; +8:  export_dir_rva
  ;; +12: num_functions (export)
  ;; +16: ordinal_base (export)
  ;; +20: addr_of_functions_rva (export)
  ;; +24: addr_of_names_rva (export)
  ;; +28: addr_of_name_ordinals_rva (export)

  ;; Load a DLL from PE_STAGING into guest memory at load_addr.
  ;; Returns DllMain entry point (guest addr), or 0 if none/error.
  (func $load_dll (export "load_dll") (param $size i32) (param $load_addr i32) (result i32)
    (local $pe_off i32) (local $num_sections i32) (local $opt_hdr_size i32)
    (local $section_off i32) (local $i i32) (local $vaddr i32) (local $vsize i32)
    (local $raw_off i32) (local $raw_size i32)
    (local $preferred_base i32) (local $delta i32)
    (local $import_rva i32) (local $export_rva i32) (local $export_size i32)
    (local $reloc_rva i32) (local $reloc_size i32)
    (local $entry_rva i32) (local $characteristics i32)
    (local $dll_idx i32) (local $tbl_ptr i32)
    (local $src i32) (local $dst i32)

    ;; Validate MZ
    (if (i32.ne (i32.load16_u (global.get $PE_STAGING)) (i32.const 0x5A4D))
      (then (return (i32.const 0))))
    (local.set $pe_off (i32.add (global.get $PE_STAGING)
      (i32.load (i32.add (global.get $PE_STAGING) (i32.const 0x3C)))))
    ;; Validate PE
    (if (i32.ne (i32.load (local.get $pe_off)) (i32.const 0x00004550))
      (then (return (i32.const 0))))

    (local.set $num_sections (i32.load16_u (i32.add (local.get $pe_off) (i32.const 6))))
    (local.set $opt_hdr_size (i32.load16_u (i32.add (local.get $pe_off) (i32.const 20))))
    (local.set $preferred_base (i32.load (i32.add (local.get $pe_off) (i32.const 52))))
    (local.set $entry_rva (i32.load (i32.add (local.get $pe_off) (i32.const 40))))
    (local.set $delta (i32.sub (local.get $load_addr) (local.get $preferred_base)))

    ;; Read data directories
    (local.set $export_rva (i32.load (i32.add (local.get $pe_off) (i32.const 120))))
    (local.set $export_size (i32.load (i32.add (local.get $pe_off) (i32.const 124))))
    (local.set $import_rva (i32.load (i32.add (local.get $pe_off) (i32.const 128))))
    (local.set $reloc_rva (i32.load (i32.add (local.get $pe_off) (i32.const 160))))
    (local.set $reloc_size (i32.load (i32.add (local.get $pe_off) (i32.const 164))))

    ;; Map sections
    (local.set $section_off (i32.add (local.get $pe_off) (i32.add (i32.const 24) (local.get $opt_hdr_size))))
    (local.set $i (i32.const 0))
    (block $sd (loop $sl
      (br_if $sd (i32.ge_u (local.get $i) (local.get $num_sections)))
      (local.set $vaddr (i32.load (i32.add (local.get $section_off) (i32.const 12))))
      (local.set $raw_size (i32.load (i32.add (local.get $section_off) (i32.const 16))))
      (local.set $raw_off (i32.load (i32.add (local.get $section_off) (i32.const 20))))
      (local.set $characteristics (i32.load (i32.add (local.get $section_off) (i32.const 36))))
      (local.set $vsize (i32.load (i32.add (local.get $section_off) (i32.const 8))))
      (local.set $dst (call $g2w (i32.add (local.get $load_addr) (local.get $vaddr))))
      (if (i32.gt_u (local.get $raw_size) (i32.const 0))
        (then
          (local.set $src (i32.add (global.get $PE_STAGING) (local.get $raw_off)))
          (call $memcpy (local.get $dst) (local.get $src) (local.get $raw_size))))
      ;; Zero BSS portion: if VirtualSize > RawSize, zero the remainder
      (if (i32.gt_u (local.get $vsize) (local.get $raw_size))
        (then (call $zero_memory
          (i32.add (local.get $dst) (local.get $raw_size))
          (i32.sub (local.get $vsize) (local.get $raw_size)))))
      (local.set $section_off (i32.add (local.get $section_off) (i32.const 40)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sl)))

    ;; Process base relocations
    (if (i32.and (i32.ne (local.get $reloc_rva) (i32.const 0))
                 (i32.ne (local.get $delta) (i32.const 0)))
      (then (call $process_relocations (local.get $load_addr) (local.get $reloc_rva) (local.get $reloc_size) (local.get $delta))))

    ;; Store DLL metadata in DLL_TABLE
    (local.set $dll_idx (global.get $dll_count))
    (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $dll_idx) (i32.const 32))))
    (i32.store (local.get $tbl_ptr) (local.get $load_addr))
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 4))
      (i32.load (i32.add (local.get $pe_off) (i32.const 80)))) ;; SizeOfImage

    ;; Parse export directory
    (if (i32.ne (local.get $export_rva) (i32.const 0))
      (then (call $parse_exports (local.get $tbl_ptr) (local.get $load_addr) (local.get $export_rva))))

    ;; Process DLL's own imports (resolve to our thunks)
    (if (i32.ne (local.get $import_rva) (i32.const 0))
      (then (call $process_dll_imports (local.get $load_addr) (local.get $import_rva))))

    (global.set $dll_count (i32.add (global.get $dll_count) (i32.const 1)))

    ;; Return DllMain entry point
    (if (result i32) (i32.ne (local.get $entry_rva) (i32.const 0))
      (then (i32.add (local.get $load_addr) (local.get $entry_rva)))
      (else (i32.const 0))))

  ;; Process base relocations: apply delta to all HIGHLOW fixups
  (func $process_relocations (param $load_addr i32) (param $reloc_rva i32) (param $reloc_size i32) (param $delta i32)
    (local $ptr i32) (local $end i32) (local $block_va i32) (local $block_size i32)
    (local $num_entries i32) (local $j i32) (local $entry i32) (local $type i32) (local $offset i32)
    (local $fixup_wa i32) (local $old_val i32)
    (local.set $ptr (call $g2w (i32.add (local.get $load_addr) (local.get $reloc_rva))))
    (local.set $end (i32.add (local.get $ptr) (local.get $reloc_size)))
    (block $done (loop $block
      (br_if $done (i32.ge_u (local.get $ptr) (local.get $end)))
      (local.set $block_va (i32.load (local.get $ptr)))
      (local.set $block_size (i32.load (i32.add (local.get $ptr) (i32.const 4))))
      (br_if $done (i32.eqz (local.get $block_size)))
      (local.set $num_entries (i32.shr_u (i32.sub (local.get $block_size) (i32.const 8)) (i32.const 1)))
      (local.set $j (i32.const 0))
      (block $ed (loop $el
        (br_if $ed (i32.ge_u (local.get $j) (local.get $num_entries)))
        (local.set $entry (i32.load16_u (i32.add (local.get $ptr) (i32.add (i32.const 8) (i32.shl (local.get $j) (i32.const 1))))))
        (local.set $type (i32.shr_u (local.get $entry) (i32.const 12)))
        (local.set $offset (i32.and (local.get $entry) (i32.const 0xFFF)))
        ;; Type 3 = IMAGE_REL_BASED_HIGHLOW (32-bit fixup)
        (if (i32.eq (local.get $type) (i32.const 3))
          (then
            (local.set $fixup_wa (call $g2w (i32.add (local.get $load_addr) (i32.add (local.get $block_va) (local.get $offset)))))
            (local.set $old_val (i32.load (local.get $fixup_wa)))
            (i32.store (local.get $fixup_wa) (i32.add (local.get $old_val) (local.get $delta)))))
        ;; Type 0 = IMAGE_REL_BASED_ABSOLUTE (padding, skip)
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $el)))
      (local.set $ptr (i32.add (local.get $ptr) (local.get $block_size)))
      (br $block))))

  ;; Parse export directory and store metadata in DLL_TABLE entry
  (func $parse_exports (param $tbl_ptr i32) (param $load_addr i32) (param $export_rva i32)
    (local $exp_wa i32)
    (local.set $exp_wa (call $g2w (i32.add (local.get $load_addr) (local.get $export_rva))))
    ;; Store export info
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 8)) (local.get $export_rva))
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 12))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 20)))) ;; NumberOfFunctions
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 16))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 16)))) ;; OrdinalBase
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 20))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 28)))) ;; AddressOfFunctions RVA
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 24))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 32)))) ;; AddressOfNames RVA
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 28))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 36))))) ;; AddressOfNameOrdinals RVA

  ;; Resolve an ordinal export from a loaded DLL. Returns guest address of function.
  (func $resolve_ordinal (param $dll_idx i32) (param $ordinal i32) (result i32)
    (local $tbl_ptr i32) (local $load_addr i32) (local $func_idx i32)
    (local $func_rva i32) (local $aof_rva i32)
    (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $dll_idx) (i32.const 32))))
    (local.set $load_addr (i32.load (local.get $tbl_ptr)))
    (local.set $func_idx (i32.sub (local.get $ordinal) (i32.load (i32.add (local.get $tbl_ptr) (i32.const 16))))) ;; ordinal - OrdinalBase
    ;; Bounds check
    (if (i32.or (i32.lt_s (local.get $func_idx) (i32.const 0))
                (i32.ge_u (local.get $func_idx) (i32.load (i32.add (local.get $tbl_ptr) (i32.const 12)))))
      (then (return (i32.const 0))))
    (local.set $aof_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 20))))
    (local.set $func_rva (i32.load (call $g2w (i32.add (local.get $load_addr)
      (i32.add (local.get $aof_rva) (i32.shl (local.get $func_idx) (i32.const 2)))))))
    (if (result i32) (i32.eqz (local.get $func_rva))
      (then (i32.const 0))
      (else (i32.add (local.get $load_addr) (local.get $func_rva)))))

  ;; Resolve a named export from a loaded DLL. Returns guest address or 0.
  (func $resolve_name_export (param $dll_idx i32) (param $name_wa i32) (result i32)
    (local $tbl_ptr i32) (local $load_addr i32)
    (local $num_names i32) (local $aon_rva i32) (local $ano_rva i32) (local $aof_rva i32)
    (local $i i32) (local $name_rva i32) (local $cmp_wa i32) (local $ordinal_idx i32)
    (local $func_rva i32)
    (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $dll_idx) (i32.const 32))))
    (local.set $load_addr (i32.load (local.get $tbl_ptr)))
    ;; Read from export directory (stored in DLL_TABLE)
    ;; NumNames is in export_dir+24, but we only stored NumFunctions. Use linear search.
    ;; Actually we need NumNames from the export dir itself.
    (local.set $aon_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 24)))) ;; AddressOfNames
    (local.set $ano_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 28)))) ;; AddressOfNameOrdinals
    (local.set $aof_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 20)))) ;; AddressOfFunctions
    ;; Get NumNames from export directory
    (local.set $num_names (i32.load (i32.add
      (call $g2w (i32.add (local.get $load_addr) (i32.load (i32.add (local.get $tbl_ptr) (i32.const 8)))))
      (i32.const 24))))
    ;; Linear search through name table
    (local.set $i (i32.const 0))
    (block $found (block $notfound (loop $search
      (br_if $notfound (i32.ge_u (local.get $i) (local.get $num_names)))
      ;; Get name RVA
      (local.set $name_rva (i32.load (call $g2w (i32.add (local.get $load_addr)
        (i32.add (local.get $aon_rva) (i32.shl (local.get $i) (i32.const 2)))))))
      (local.set $cmp_wa (call $g2w (i32.add (local.get $load_addr) (local.get $name_rva))))
      ;; Compare names (both are WASM addresses of null-terminated strings)
      (if (call $str_eq (local.get $name_wa) (local.get $cmp_wa))
        (then
          ;; Get ordinal index from AddressOfNameOrdinals
          (local.set $ordinal_idx (i32.load16_u (call $g2w (i32.add (local.get $load_addr)
            (i32.add (local.get $ano_rva) (i32.shl (local.get $i) (i32.const 1)))))))
          ;; Get function RVA
          (local.set $func_rva (i32.load (call $g2w (i32.add (local.get $load_addr)
            (i32.add (local.get $aof_rva) (i32.shl (local.get $ordinal_idx) (i32.const 2)))))))
          (br $found)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $search)))
    (return (i32.const 0))) ;; not found
    (i32.add (local.get $load_addr) (local.get $func_rva)))

  ;; Compare two null-terminated strings at WASM addresses
  (func $str_eq (param $a i32) (param $b i32) (result i32)
    (local $i i32) (local $ca i32) (local $cb i32)
    (block $no (loop $l
      (local.set $ca (i32.load8_u (i32.add (local.get $a) (local.get $i))))
      (local.set $cb (i32.load8_u (i32.add (local.get $b) (local.get $i))))
      (br_if $no (i32.ne (local.get $ca) (local.get $cb)))
      (if (i32.eqz (local.get $ca)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.const 0))

  ;; Process a loaded DLL's imports — create thunks for system DLLs,
  ;; resolve against other loaded DLLs if found.
  (func $process_dll_imports (param $load_addr i32) (param $import_rva i32)
    (local $desc_ptr i32) (local $ilt_rva i32) (local $iat_rva i32)
    (local $ilt_ptr i32) (local $iat_ptr i32) (local $entry i32) (local $thunk_addr i32)
    (local $dll_name_rva i32) (local $dll_name_ptr i32)
    (local $resolved_dll i32) (local $resolved_addr i32)
    (local.set $desc_ptr (call $g2w (i32.add (local.get $load_addr) (local.get $import_rva))))
    (block $id (loop $dl
      (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
      (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))
      (br_if $id (i32.eqz (local.get $ilt_rva)))
      ;; Get imported DLL name
      (local.set $dll_name_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 12))))
      (local.set $dll_name_ptr (i32.add (local.get $load_addr) (local.get $dll_name_rva)))
      ;; Check if this DLL is loaded — search DLL_TABLE
      (local.set $resolved_dll (call $find_loaded_dll (local.get $dll_name_ptr)))
      (local.set $ilt_ptr (call $g2w (i32.add (local.get $load_addr) (local.get $ilt_rva))))
      (local.set $iat_ptr (call $g2w (i32.add (local.get $load_addr) (local.get $iat_rva))))
      (block $fd (loop $fl
        (local.set $entry (i32.load (local.get $ilt_ptr)))
        (br_if $fd (i32.eqz (local.get $entry)))
        (if (i32.ge_s (local.get $resolved_dll) (i32.const 0))
          (then
            ;; Resolve against loaded DLL
            (if (i32.and (local.get $entry) (i32.const 0x80000000))
              (then
                ;; Ordinal import
                (local.set $resolved_addr (call $resolve_ordinal (local.get $resolved_dll)
                  (i32.and (local.get $entry) (i32.const 0xFFFF)))))
              (else
                ;; Name import — get name from hint/name table
                (local.set $resolved_addr (call $resolve_name_export (local.get $resolved_dll)
                  (call $g2w (i32.add (local.get $load_addr) (i32.add (local.get $entry) (i32.const 2))))))))
            (i32.store (local.get $iat_ptr) (local.get $resolved_addr)))
          (else
            ;; System DLL — create thunk
            (local.set $thunk_addr (i32.add
              (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                       (global.get $GUEST_BASE))
              (global.get $image_base)))
            (i32.store (local.get $iat_ptr) (local.get $thunk_addr))
            (if (i32.eqz (i32.and (local.get $entry) (i32.const 0x80000000)))
              (then
                ;; Name import: store name RVA relative to guest base
                ;; The name is at load_addr + entry, but thunk expects RVA from image_base
                ;; Compute: (load_addr + entry) - image_base = RVA for thunk
                (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                  (i32.sub (i32.add (local.get $load_addr) (local.get $entry)) (global.get $image_base)))
                (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
                  (call $lookup_api_id (call $g2w (i32.add (local.get $load_addr) (i32.add (local.get $entry) (i32.const 2)))))))
              (else
                ;; Ordinal import — store marker and ordinal (will hit fallback)
                (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                  (i32.const 0x4F524400)) ;; "ORD\0" marker
                (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
                  (i32.const 0xFFFF))))
            (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))))
        (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
        (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
        (br $fl)))
      (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
      (br $dl))))

  ;; Find a loaded DLL by name (guest address of name string).
  ;; Returns dll_idx (0-based) or -1 if not found.
  ;; Compares against DLL export names stored in export directory.
  (func $find_loaded_dll (param $name_ptr i32) (result i32)
    (local $i i32) (local $tbl_ptr i32) (local $la i32) (local $exp_rva i32)
    (local $exp_name_rva i32) (local $exp_name_wa i32)
    (local.set $i (i32.const 0))
    (block $notfound (loop $search
      (br_if $notfound (i32.ge_u (local.get $i) (global.get $dll_count)))
      (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $i) (i32.const 32))))
      (local.set $la (i32.load (local.get $tbl_ptr)))
      (local.set $exp_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 8))))
      (if (i32.ne (local.get $exp_rva) (i32.const 0))
        (then
          ;; Get export directory name RVA
          (local.set $exp_name_rva (i32.load (i32.add (call $g2w (i32.add (local.get $la) (local.get $exp_rva))) (i32.const 12))))
          (local.set $exp_name_wa (call $g2w (i32.add (local.get $la) (local.get $exp_name_rva))))
          ;; Compare (case-insensitive)
          (if (call $dll_name_match (local.get $name_ptr) (local.get $exp_name_wa))
            (then (return (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $search)))
    (i32.const -1))

  ;; Patch a caller's imports for a specific loaded DLL.
  ;; Walks the caller's import descriptor and resolves against DLL exports.
  (func $patch_caller_iat (export "patch_caller_iat")
    (param $caller_base i32) (param $caller_import_rva i32)
    (param $target_dll_name_ptr i32) (param $dll_idx i32)
    (local $desc_ptr i32) (local $ilt_rva i32) (local $iat_rva i32)
    (local $dll_name_rva i32) (local $dll_name_ga i32)
    (local $ilt_ptr i32) (local $iat_ptr i32) (local $entry i32)
    (local $resolved i32)
    (local.set $desc_ptr (call $g2w (i32.add (local.get $caller_base) (local.get $caller_import_rva))))
    (block $id (loop $dl
      (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
      (br_if $id (i32.eqz (local.get $ilt_rva)))
      ;; Check if this descriptor's DLL name matches
      (local.set $dll_name_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 12))))
      (local.set $dll_name_ga (i32.add (local.get $caller_base) (local.get $dll_name_rva)))
      (if (call $dll_name_match (local.get $dll_name_ga) (call $g2w (local.get $target_dll_name_ptr)))
        (then
          ;; Found matching descriptor — patch all IAT entries
          (local.set $ilt_ptr (call $g2w (i32.add (local.get $caller_base) (local.get $ilt_rva))))
          (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))
          (local.set $iat_ptr (call $g2w (i32.add (local.get $caller_base) (local.get $iat_rva))))
          (block $fd (loop $fl
            (local.set $entry (i32.load (local.get $ilt_ptr)))
            (br_if $fd (i32.eqz (local.get $entry)))
            (if (i32.and (local.get $entry) (i32.const 0x80000000))
              (then
                ;; Ordinal import
                (local.set $resolved (call $resolve_ordinal (local.get $dll_idx)
                  (i32.and (local.get $entry) (i32.const 0xFFFF)))))
              (else
                ;; Name import
                (local.set $resolved (call $resolve_name_export (local.get $dll_idx)
                  (call $g2w (i32.add (local.get $caller_base) (i32.add (local.get $entry) (i32.const 2))))))))
            (if (local.get $resolved)
              (then (i32.store (local.get $iat_ptr) (local.get $resolved))))
            (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
            (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
            (br $fl)))))
      (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
      (br $dl))))

  ;; Get next available DLL load address (page-aligned after EXE + heap margin)
  (func (export "get_next_dll_addr") (result i32)
    (local $addr i32)
    (if (result i32) (global.get $dll_count)
      (then
        ;; After last loaded DLL
        (local.set $addr (i32.add (global.get $DLL_TABLE) (i32.mul (i32.sub (global.get $dll_count) (i32.const 1)) (i32.const 32))))
        ;; load_addr + size_of_image, page-aligned
        (i32.and
          (i32.add (i32.add (i32.load (local.get $addr)) (i32.load (i32.add (local.get $addr) (i32.const 4)))) (i32.const 0xFFF))
          (i32.const 0xFFFFF000)))
      (else
        ;; First DLL: after EXE's SizeOfImage
        (i32.and
          (i32.add (i32.add (global.get $image_base) (global.get $exe_size_of_image)) (i32.const 0xFFF))
          (i32.const 0xFFFFF000)))))

  (func (export "get_exe_size_of_image") (result i32) (global.get $exe_size_of_image))
  (func (export "get_dll_count") (result i32) (global.get $dll_count))
  ;; ============================================================
  ;; WIN32 API DISPATCH (table-driven)
  ;; ============================================================
  (func $win32_dispatch (param $thunk_idx i32)
    (local $api_id i32) (local $name_rva i32) (local $name_ptr i32)
    (local $arg0 i32) (local $arg1 i32) (local $arg2 i32) (local $arg3 i32)
    (local $arg4 i32)
    (local $w0 i32) (local $w1 i32) (local $w2 i32)
    (local $msg_ptr i32) (local $tmp i32) (local $packed i32)
    (local $i i32) (local $j i32) (local $v i32)

    ;; Read thunk data
    (local.set $name_rva (i32.load (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8)))))
    (local.set $api_id (i32.load (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8))) (i32.const 4))))

    ;; Catch-return thunk
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0000))
      (then (global.set $eip (global.get $eax)) (return)))

    (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))

    ;; Load args from guest stack
    (local.set $arg0 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (local.set $arg1 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    (local.set $arg2 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))
    (local.set $arg3 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (local.set $arg4 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))

    ;; Load name words for sub-dispatchers
    (local.set $w0 (i32.load (local.get $name_ptr)))
    (local.set $w1 (i32.load (i32.add (local.get $name_ptr) (i32.const 4))))
    (local.set $w2 (i32.load (i32.add (local.get $name_ptr) (i32.const 8))))

    ;; Log API name
    (call $host_log (local.get $name_ptr) (i32.const 32))

    ;; === O(1) br_table dispatch ===
    (block $fallback
    (block $api_347
    (block $api_346
    (block $api_345
    (block $api_344
    (block $api_343
    (block $api_342
    (block $api_341
    (block $api_340
    (block $api_339
    (block $api_338
    (block $api_337
    (block $api_336
    (block $api_335
    (block $api_334
    (block $api_333
    (block $api_332
    (block $api_331
    (block $api_330
    (block $api_329
    (block $api_328
    (block $api_327
    (block $api_326
    (block $api_325
    (block $api_324
    (block $api_323
    (block $api_322
    (block $api_321
    (block $api_320
    (block $api_319
    (block $api_318
    (block $api_317
    (block $api_316
    (block $api_315
    (block $api_314
    (block $api_313
    (block $api_312
    (block $api_311
    (block $api_310
    (block $api_309
    (block $api_308
    (block $api_307
    (block $api_306
    (block $api_305
    (block $api_304
    (block $api_303
    (block $api_302
    (block $api_301
    (block $api_300
    (block $api_299
    (block $api_298
    (block $api_297
    (block $api_296
    (block $api_295
    (block $api_294
    (block $api_293
    (block $api_292
    (block $api_291
    (block $api_290
    (block $api_289
    (block $api_288
    (block $api_287
    (block $api_286
    (block $api_285
    (block $api_284
    (block $api_283
    (block $api_282
    (block $api_281
    (block $api_280
    (block $api_279
    (block $api_278
    (block $api_277
    (block $api_276
    (block $api_275
    (block $api_274
    (block $api_273
    (block $api_272
    (block $api_271
    (block $api_270
    (block $api_269
    (block $api_268
    (block $api_267
    (block $api_266
    (block $api_265
    (block $api_264
    (block $api_263
    (block $api_262
    (block $api_261
    (block $api_260
    (block $api_259
    (block $api_258
    (block $api_257
    (block $api_256
    (block $api_255
    (block $api_254
    (block $api_253
    (block $api_252
    (block $api_251
    (block $api_250
    (block $api_249
    (block $api_248
    (block $api_247
    (block $api_246
    (block $api_245
    (block $api_244
    (block $api_243
    (block $api_242
    (block $api_241
    (block $api_240
    (block $api_239
    (block $api_238
    (block $api_237
    (block $api_236
    (block $api_235
    (block $api_234
    (block $api_233
    (block $api_232
    (block $api_231
    (block $api_230
    (block $api_229
    (block $api_228
    (block $api_227
    (block $api_226
    (block $api_225
    (block $api_224
    (block $api_223
    (block $api_222
    (block $api_221
    (block $api_220
    (block $api_219
    (block $api_218
    (block $api_217
    (block $api_216
    (block $api_215
    (block $api_214
    (block $api_213
    (block $api_212
    (block $api_211
    (block $api_210
    (block $api_209
    (block $api_208
    (block $api_207
    (block $api_206
    (block $api_205
    (block $api_204
    (block $api_203
    (block $api_202
    (block $api_201
    (block $api_200
    (block $api_199
    (block $api_198
    (block $api_197
    (block $api_196
    (block $api_195
    (block $api_194
    (block $api_193
    (block $api_192
    (block $api_191
    (block $api_190
    (block $api_189
    (block $api_188
    (block $api_187
    (block $api_186
    (block $api_185
    (block $api_184
    (block $api_183
    (block $api_182
    (block $api_181
    (block $api_180
    (block $api_179
    (block $api_178
    (block $api_177
    (block $api_176
    (block $api_175
    (block $api_174
    (block $api_173
    (block $api_172
    (block $api_171
    (block $api_170
    (block $api_169
    (block $api_168
    (block $api_167
    (block $api_166
    (block $api_165
    (block $api_164
    (block $api_163
    (block $api_162
    (block $api_161
    (block $api_160
    (block $api_159
    (block $api_158
    (block $api_157
    (block $api_156
    (block $api_155
    (block $api_154
    (block $api_153
    (block $api_152
    (block $api_151
    (block $api_150
    (block $api_149
    (block $api_148
    (block $api_147
    (block $api_146
    (block $api_145
    (block $api_144
    (block $api_143
    (block $api_142
    (block $api_141
    (block $api_140
    (block $api_139
    (block $api_138
    (block $api_137
    (block $api_136
    (block $api_135
    (block $api_134
    (block $api_133
    (block $api_132
    (block $api_131
    (block $api_130
    (block $api_129
    (block $api_128
    (block $api_127
    (block $api_126
    (block $api_125
    (block $api_124
    (block $api_123
    (block $api_122
    (block $api_121
    (block $api_120
    (block $api_119
    (block $api_118
    (block $api_117
    (block $api_116
    (block $api_115
    (block $api_114
    (block $api_113
    (block $api_112
    (block $api_111
    (block $api_110
    (block $api_109
    (block $api_108
    (block $api_107
    (block $api_106
    (block $api_105
    (block $api_104
    (block $api_103
    (block $api_102
    (block $api_101
    (block $api_100
    (block $api_99
    (block $api_98
    (block $api_97
    (block $api_96
    (block $api_95
    (block $api_94
    (block $api_93
    (block $api_92
    (block $api_91
    (block $api_90
    (block $api_89
    (block $api_88
    (block $api_87
    (block $api_86
    (block $api_85
    (block $api_84
    (block $api_83
    (block $api_82
    (block $api_81
    (block $api_80
    (block $api_79
    (block $api_78
    (block $api_77
    (block $api_76
    (block $api_75
    (block $api_74
    (block $api_73
    (block $api_72
    (block $api_71
    (block $api_70
    (block $api_69
    (block $api_68
    (block $api_67
    (block $api_66
    (block $api_65
    (block $api_64
    (block $api_63
    (block $api_62
    (block $api_61
    (block $api_60
    (block $api_59
    (block $api_58
    (block $api_57
    (block $api_56
    (block $api_55
    (block $api_54
    (block $api_53
    (block $api_52
    (block $api_51
    (block $api_50
    (block $api_49
    (block $api_48
    (block $api_47
    (block $api_46
    (block $api_45
    (block $api_44
    (block $api_43
    (block $api_42
    (block $api_41
    (block $api_40
    (block $api_39
    (block $api_38
    (block $api_37
    (block $api_36
    (block $api_35
    (block $api_34
    (block $api_33
    (block $api_32
    (block $api_31
    (block $api_30
    (block $api_29
    (block $api_28
    (block $api_27
    (block $api_26
    (block $api_25
    (block $api_24
    (block $api_23
    (block $api_22
    (block $api_21
    (block $api_20
    (block $api_19
    (block $api_18
    (block $api_17
    (block $api_16
    (block $api_15
    (block $api_14
    (block $api_13
    (block $api_12
    (block $api_11
    (block $api_10
    (block $api_9
    (block $api_8
    (block $api_7
    (block $api_6
    (block $api_5
    (block $api_4
    (block $api_3
    (block $api_2
    (block $api_1
    (block $api_0
      (br_table $api_0 $api_1 $api_2 $api_3 $api_4 $api_5 $api_6 $api_7 $api_8 $api_9 $api_10 $api_11 $api_12 $api_13 $api_14 $api_15 $api_16 $api_17 $api_18 $api_19 $api_20 $api_21 $api_22 $api_23 $api_24 $api_25 $api_26 $api_27 $api_28 $api_29 $api_30 $api_31 $api_32 $api_33 $api_34 $api_35 $api_36 $api_37 $api_38 $api_39 $api_40 $api_41 $api_42 $api_43 $api_44 $api_45 $api_46 $api_47 $api_48 $api_49 $api_50 $api_51 $api_52 $api_53 $api_54 $api_55 $api_56 $api_57 $api_58 $api_59 $api_60 $api_61 $api_62 $api_63 $api_64 $api_65 $api_66 $api_67 $api_68 $api_69 $api_70 $api_71 $api_72 $api_73 $api_74 $api_75 $api_76 $api_77 $api_78 $api_79 $api_80 $api_81 $api_82 $api_83 $api_84 $api_85 $api_86 $api_87 $api_88 $api_89 $api_90 $api_91 $api_92 $api_93 $api_94 $api_95 $api_96 $api_97 $api_98 $api_99 $api_100 $api_101 $api_102 $api_103 $api_104 $api_105 $api_106 $api_107 $api_108 $api_109 $api_110 $api_111 $api_112 $api_113 $api_114 $api_115 $api_116 $api_117 $api_118 $api_119 $api_120 $api_121 $api_122 $api_123 $api_124 $api_125 $api_126 $api_127 $api_128 $api_129 $api_130 $api_131 $api_132 $api_133 $api_134 $api_135 $api_136 $api_137 $api_138 $api_139 $api_140 $api_141 $api_142 $api_143 $api_144 $api_145 $api_146 $api_147 $api_148 $api_149 $api_150 $api_151 $api_152 $api_153 $api_154 $api_155 $api_156 $api_157 $api_158 $api_159 $api_160 $api_161 $api_162 $api_163 $api_164 $api_165 $api_166 $api_167 $api_168 $api_169 $api_170 $api_171 $api_172 $api_173 $api_174 $api_175 $api_176 $api_177 $api_178 $api_179 $api_180 $api_181 $api_182 $api_183 $api_184 $api_185 $api_186 $api_187 $api_188 $api_189 $api_190 $api_191 $api_192 $api_193 $api_194 $api_195 $api_196 $api_197 $api_198 $api_199 $api_200 $api_201 $api_202 $api_203 $api_204 $api_205 $api_206 $api_207 $api_208 $api_209 $api_210 $api_211 $api_212 $api_213 $api_214 $api_215 $api_216 $api_217 $api_218 $api_219 $api_220 $api_221 $api_222 $api_223 $api_224 $api_225 $api_226 $api_227 $api_228 $api_229 $api_230 $api_231 $api_232 $api_233 $api_234 $api_235 $api_236 $api_237 $api_238 $api_239 $api_240 $api_241 $api_242 $api_243 $api_244 $api_245 $api_246 $api_247 $api_248 $api_249 $api_250 $api_251 $api_252 $api_253 $api_254 $api_255 $api_256 $api_257 $api_258 $api_259 $api_260 $api_261 $api_262 $api_263 $api_264 $api_265 $api_266 $api_267 $api_268 $api_269 $api_270 $api_271 $api_272 $api_273 $api_274 $api_275 $api_276 $api_277 $api_278 $api_279 $api_280 $api_281 $api_282 $api_283 $api_284 $api_285 $api_286 $api_287 $api_288 $api_289 $api_290 $api_291 $api_292 $api_293 $api_294 $api_295 $api_296 $api_297 $api_298 $api_299 $api_300 $api_301 $api_302 $api_303 $api_304 $api_305 $api_306 $api_307 $api_308 $api_309 $api_310 $api_311 $api_312 $api_313 $api_314 $api_315 $api_316 $api_317 $api_318 $api_319 $api_320 $api_321 $api_322 $api_323 $api_324 $api_325 $api_326 $api_327 $api_328 $api_329 $api_330 $api_331 $api_332 $api_333 $api_334 $api_335 $api_336 $api_337 $api_338 $api_339 $api_340 $api_341 $api_342 $api_343 $api_344 $api_345 $api_346 $api_347 $fallback (local.get $api_id))
    ) ;; 0: ExitProcess
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
      (call $host_exit (local.get $arg0)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)
    (return)
    ) ;; 1: GetModuleHandleA
      (global.set $eax (global.get $image_base))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 2: GetCommandLineA
      (call $store_fake_cmdline) (global.set $eax (global.get $fake_cmdline_addr))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 3: GetStartupInfoA
      (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 68))
      (call $gs32 (local.get $arg0) (i32.const 68))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 4: GetProcAddress
      (block $gpa
      ;; If lpProcName is an ordinal (< 0x10000), return 0 (unsupported)
      (br_if $gpa (i32.lt_u (local.get $arg1) (i32.const 0x10000)))
      ;; Allocate hint(2) + name in guest heap
      (local.set $tmp (call $guest_strlen (local.get $arg1)))
      (local.set $v (call $heap_alloc (i32.add (local.get $tmp) (i32.const 3)))) ;; 2 hint + name + NUL
      ;; Write hint = 0
      (i32.store16 (call $g2w (local.get $v)) (i32.const 0))
      ;; Copy name string
      (call $memcpy (i32.add (call $g2w (local.get $v)) (i32.const 2))
      (call $g2w (local.get $arg1)) (i32.add (local.get $tmp) (i32.const 1)))
      ;; Create thunk: store RVA (guest_ptr - image_base) at THUNK_BASE + num_thunks*8
      (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.sub (local.get $v) (global.get $image_base)))
      ;; Compute guest address of this thunk
      (global.set $eax (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (global.get $GUEST_BASE))
      (global.get $image_base)))
      (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 5: GetLastError
      (global.set $eax (global.get $last_error))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 6: GetLocalTime
      (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 7: GetTimeFormatA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 8: GetDateFormatA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 9: GetProfileStringA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 10: GetProfileIntA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 11: GetLocaleInfoA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 12: LoadLibraryA
      (global.set $eax (i32.const 0x7FFE0000))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 13: DeleteFileA
      (global.set $eax (i32.const 0)) (global.set $last_error (i32.const 2))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 14: CreateFileA
      (global.set $eax (i32.const 0xFFFFFFFF))
      (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)
    (return)
    ) ;; 15: FindFirstFileA
      (global.set $eax (i32.const 0xFFFFFFFF))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 16: FindClose
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 17: MulDiv
      (if (i32.eqz (local.get $arg2))
      (then (global.set $eax (i32.const -1)))
      (else (global.set $eax (i32.wrap_i64 (i64.div_s
      (i64.mul (i64.extend_i32_s (local.get $arg0)) (i64.extend_i32_s (local.get $arg1)))
      (i64.extend_i32_s (local.get $arg2)))))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 18: RtlMoveMemory
      (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 19: _lcreat
      (global.set $eax (i32.const 0xFFFFFFFF))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 20: _lopen
      (global.set $eax (i32.const 0xFFFFFFFF))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 21: _lwrite
      (global.set $eax (i32.const 0xFFFFFFFF))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 22: _llseek
      (global.set $eax (i32.const 0xFFFFFFFF))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 23: _lclose
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 24: _lread
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 25: Sleep
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 26: CloseHandle
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 27: CreateEventA
      (global.set $eax (i32.const 0x70001)) ;; fake event handle
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 28: CreateThread
      (global.set $eax (i32.const 0x70002)) ;; fake thread handle
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 29: WaitForSingleObject
      (global.set $eax (i32.const 0)) ;; WAIT_OBJECT_0
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 30: ResetEvent
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 31: SetEvent
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 32: WriteProfileStringA
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 33: HeapCreate
      (global.set $eax (i32.const 0x00080000)) ;; fake heap handle
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 34: HeapDestroy
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 35: HeapAlloc
      (global.set $eax (call $heap_alloc (local.get $arg2)))
      ;; Zero memory if HEAP_ZERO_MEMORY (0x08)
      (if (i32.and (local.get $arg1) (i32.const 0x08))
      (then (call $zero_memory (call $g2w (global.get $eax)) (local.get $arg2))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 36: HeapFree
      (call $heap_free (local.get $arg2))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 37: HeapReAlloc
      (local.set $tmp (call $heap_alloc (local.get $arg3)))
      (if (local.get $tmp)
      (then
      (if (local.get $arg2) ;; old ptr
      (then (call $memcpy (call $g2w (local.get $tmp)) (call $g2w (local.get $arg2)) (local.get $arg3))
      (call $heap_free (local.get $arg2))))))
      (global.set $eax (local.get $tmp))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 38: VirtualAlloc
      (if (local.get $arg0)
      (then (global.set $eax (local.get $arg0))) ;; requested address, just return it
      (else (global.set $eax (call $heap_alloc (local.get $arg1)))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 39: VirtualFree
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 40: GetACP
      (global.set $eax (i32.const 1252))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 41: GetOEMCP
      (global.set $eax (i32.const 437))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 42: GetCPInfo
      ;; CPINFO struct: MaxCharSize(4), DefaultChar[2](2), LeadByte[12](12)
      (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 18))
      (call $gs32 (local.get $arg1) (i32.const 1)) ;; MaxCharSize = 1 (single-byte)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 43: MultiByteToWideChar
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
    (return)
    ) ;; 44: WideCharToMultiByte
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
    (return)
    ) ;; 45: GetStringTypeA
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 46: GetStringTypeW
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 47: LCMapStringA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 48: LCMapStringW
      ;; STD_INPUT=0xFFFFFFF6(-10), STD_OUTPUT=0xFFFFFFF5(-11), STD_ERROR=0xFFFFFFF4(-12)
      (global.set $eax (i32.add (i32.const 0x40000) (i32.and (local.get $arg0) (i32.const 0xFF))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 49: GetStdHandle
      ;; STD_INPUT=0xFFFFFFF6(-10), STD_OUTPUT=0xFFFFFFF5(-11), STD_ERROR=0xFFFFFFF4(-12)
      (global.set $eax (i32.add (i32.const 0x40000) (i32.and (local.get $arg0) (i32.const 0xFF))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 50: GetFileType
      (global.set $eax (i32.const 2)) ;; FILE_TYPE_CHAR
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 51: WriteFile
      ;; Write number of bytes written to arg2 (lpNumberOfBytesWritten)
      (if (local.get $arg2)
      (then (call $gs32 (local.get $arg2) (local.get $arg1))))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 52: SetHandleCount
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 53: GetEnvironmentStrings
      ;; Return "A=B\0\0" — must be non-empty so CRT sets _environ
      (local.set $tmp (call $heap_alloc (i32.const 8)))
      (call $gs32 (local.get $tmp) (i32.const 0x423D41))  ;; "A=B\0"
      (call $gs32 (i32.add (local.get $tmp) (i32.const 4)) (i32.const 0))
      (global.set $eax (local.get $tmp))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 54: GetModuleFileNameA
      ;; Write "C:\\app.exe" to buffer
      (i32.store (call $g2w (local.get $arg1)) (i32.const 0x615C3A43)) ;; "C:\a"
      (i32.store (i32.add (call $g2w (local.get $arg1)) (i32.const 4)) (i32.const 0x652E7070)) ;; "pp.e"
      (i32.store16 (i32.add (call $g2w (local.get $arg1)) (i32.const 8)) (i32.const 0x6578)) ;; "xe"
      (i32.store8 (i32.add (call $g2w (local.get $arg1)) (i32.const 10)) (i32.const 0))
      (global.set $eax (i32.const 10))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 55: UnhandledExceptionFilter
      (global.set $eax (i32.const 0)) ;; EXCEPTION_EXECUTE_HANDLER
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 56: GetCurrentProcess
      (global.set $eax (i32.const 0xFFFFFFFF)) ;; pseudo-handle
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 57: TerminateProcess
      (call $host_exit (local.get $arg1)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)
    (return)
    ) ;; 58: GetTickCount
      (global.set $tick_count (i32.add (global.get $tick_count) (i32.const 16)))
      (global.set $eax (global.get $tick_count))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 59: FindResourceA
      ;; FindResourceA(hModule, lpName, lpType) → HRSRC (RVA of data entry)
      ;; arg0=hModule, arg1=lpName (MAKEINTRESOURCE or string), arg2=lpType
      ;; Walk resource directory: type(arg2) → name(arg1) → first lang → data entry RVA
      (if (i32.eqz (global.get $rsrc_rva))
      (then (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
      (global.set $eax (call $find_resource (local.get $arg2) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 60: LoadResource
      ;; LoadResource(hModule, hrsrc) → returns hrsrc (data entry offset)
      (global.set $eax (local.get $arg1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 61: LockResource
      ;; LockResource(hGlobal) → pointer to resource data
      ;; hGlobal = offset of data entry in rsrc. Read RVA from it, return image_base + RVA
      (if (i32.eqz (local.get $arg0))
      (then (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (global.set $eax (i32.add (global.get $image_base)
        (call $gl32 (i32.add (global.get $image_base) (local.get $arg0)))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 62: FreeResource
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 63: RtlUnwind
      ;; Unlink SEH chain: set FS:[0] = TargetFrame->next
      (if (i32.ne (local.get $arg0) (i32.const 0))
      (then (call $gs32 (global.get $fs_base) (call $gl32 (local.get $arg0)))))
      (global.set $eax (local.get $arg3)) ;; ReturnValue
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 64: FreeLibrary
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 65: sndPlaySoundA
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 66: RegisterWindowMessageA
      (global.set $eax (i32.const 0xC100))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 67: CreateWindowExA
      ;; Auto-detect WndProc: scan code for WNDCLASSA setup referencing this className
      ;; Pattern: C7 44 24 XX [className] — the mov before it has the WndProc
      (if (i32.eqz (global.get $wndproc_addr))
      (then
      (local.set $i (global.get $GUEST_BASE))
      (local.set $v (i32.add (global.get $GUEST_BASE) (i32.const 0xA000)))
      (block $found (loop $scan
      (br_if $found (i32.ge_u (local.get $i) (local.get $v)))
      (if (i32.and
      (i32.eq (i32.load8_u (local.get $i)) (i32.const 0xC7))
      (i32.and
      (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 1))) (i32.const 0x44))
      (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 2))) (i32.const 0x24))))
      (then
      (if (i32.eq (i32.load (i32.add (local.get $i) (i32.const 4))) (local.get $arg1))
      (then
      (if (i32.and
      (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 8))) (i32.const 0xC7))
      (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 7))) (i32.const 0x44)))
      (then
      (local.set $tmp (i32.load (i32.sub (local.get $i) (i32.const 4))))
      (if (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
      (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (i32.const 0x80000))))
      (then
      (global.set $wndproc_addr (local.get $tmp))
      (br $found)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))))
      ;; Set second wndproc for subsequent windows
      (if (i32.and (global.get $wndproc_addr) (i32.eqz (global.get $wndproc_addr2)))
      (then
      (if (global.get $main_hwnd)  ;; not the first window
      (then
      ;; Scan for second WndProc using same pattern
      (local.set $i (global.get $GUEST_BASE))
      (local.set $v (i32.add (global.get $GUEST_BASE) (i32.const 0xA000)))
      (block $found2 (loop $scan2
      (br_if $found2 (i32.ge_u (local.get $i) (local.get $v)))
      (if (i32.and
      (i32.eq (i32.load8_u (local.get $i)) (i32.const 0xC7))
      (i32.and
      (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 1))) (i32.const 0x44))
      (i32.eq (i32.load8_u (i32.add (local.get $i) (i32.const 2))) (i32.const 0x24))))
      (then
      (if (i32.eq (i32.load (i32.add (local.get $i) (i32.const 4))) (local.get $arg1))
      (then
      (if (i32.and
      (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 8))) (i32.const 0xC7))
      (i32.eq (i32.load8_u (i32.sub (local.get $i) (i32.const 7))) (i32.const 0x44)))
      (then
      (local.set $tmp (i32.load (i32.sub (local.get $i) (i32.const 4))))
      (if (i32.and (i32.ge_u (local.get $tmp) (global.get $image_base))
      (i32.lt_u (local.get $tmp) (i32.add (global.get $image_base) (i32.const 0x80000))))
      (then
      (global.set $wndproc_addr2 (local.get $tmp))
      (br $found2)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan2)))))))
      ;; Allocate HWND; first top-level window becomes main_hwnd
      (if (i32.eqz (global.get $main_hwnd))
      (then (global.set $main_hwnd (global.get $next_hwnd))))
      ;; Call host: create_window(hwnd, style, x, y, cx, cy, title_ptr, menu_id)
      (drop (call $host_create_window
      (global.get $next_hwnd)                                    ;; hwnd
      (local.get $arg3)                                           ;; style
      (local.get $arg4)                                           ;; x
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))    ;; y
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))    ;; cx
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))    ;; cy
      (call $g2w (local.get $arg2))                               ;; title_ptr (WASM ptr)
      (call $gl32 (i32.add (global.get $esp) (i32.const 40)))    ;; menu (resource ID or HMENU)
      ))
      ;; Pass className to host so it knows the window type (e.g. "Edit")
      (call $host_set_window_class (global.get $next_hwnd) (call $g2w (local.get $arg1)))
      ;; Flag to deliver WM_CREATE + WM_SIZE as first messages in GetMessageA
      (if (i32.eq (global.get $next_hwnd) (global.get $main_hwnd))
      (then
      (global.set $pending_wm_create (i32.const 1))
      ;; Store window outer dimensions; compute client area (subtract borders+titlebar+menu)
      (global.set $main_win_cx (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
      (global.set $main_win_cy (call $gl32 (i32.add (global.get $esp) (i32.const 32))))
      ;; Client = outer - borders(6) - caption(19) - menu(20) approximately
      (global.set $pending_wm_size (i32.or
      (i32.and (i32.sub (global.get $main_win_cx) (i32.const 6)) (i32.const 0xFFFF))
      (i32.shl (i32.sub (global.get $main_win_cy) (i32.const 45)) (i32.const 16))))))
      (global.set $eax (global.get $next_hwnd))
      (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)
    (return)
    ) ;; 68: CreateDialogParamA
      ;; Save dialog hwnd for IsChild/SendMessage routing
      (global.set $dlg_hwnd (i32.const 0x10002))
      ;; Clear quit_flag — dialog recreation (e.g. calc mode switch) cancels pending quit
      (global.set $quit_flag (i32.const 0))
      ;; Call host: create_dialog(hwnd, dlg_resource_id)
      (global.set $eax (call $host_create_dialog
      (i32.const 0x10002)    ;; hwnd for dialog
      (local.get $arg1)))    ;; template name/ID
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 69: MessageBoxA
      ;; Disambiguate MessageBoxA vs MessageBeep
      (if (i32.eq (local.get $w1) (i32.const 0x42656761)) ;; "ageB" — MessageB...
      (then
      (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 8))) (i32.const 0x65)) ;; "e" — MessageBe(ep)
      (then ;; MessageBeep(1)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))))
      ;; MessageBoxA(4)
      (global.set $eax (call $host_message_box (local.get $arg0)
      (call $g2w (local.get $arg1)) (call $g2w (local.get $arg2)) (local.get $arg3)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 70: MessageBeep
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (return)
    ) ;; 71: ShowWindow
      (call $host_show_window (local.get $arg0) (local.get $arg1))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 72: UpdateWindow
      (call $host_invalidate (local.get $arg0))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 73: GetMessageA
      (local.set $msg_ptr (local.get $arg0))
      ;; If quit flag set, return 0 (WM_QUIT)
      (if (global.get $quit_flag)
      (then
      ;; Fill MSG with WM_QUIT (0x0012)
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))          ;; hwnd
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0012)) ;; message=WM_QUIT
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))      ;; wParam
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))     ;; lParam
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; Deliver pending WM_CREATE before anything else
      ;; Build CREATESTRUCT at guest address 0x40C800 (scratch area) for lParam
      ;; Layout: lpCreateParams(0), hInstance(4), hMenu(8), hwndParent(12),
      ;;         cy(16), cx(20), y(24), x(28), style(32), lpszName(36), lpszClass(40), dwExStyle(44)
      (if (global.get $pending_wm_create)
      (then
      (global.set $pending_wm_create (i32.const 0))
      (call $gs32 (i32.const 0x400100) (i32.const 0))                 ;; lpCreateParams
      (call $gs32 (i32.const 0x400110) (global.get $main_win_cy))    ;; cy (+16)
      (call $gs32 (i32.const 0x400114) (global.get $main_win_cx))    ;; cx (+20)
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0x400100)) ;; lParam = &CREATESTRUCT
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; Deliver pending WM_SIZE after WM_CREATE
      (if (global.get $pending_wm_size)
      (then
      (local.set $packed (global.get $pending_wm_size))
      (global.set $pending_wm_size (i32.const 0))
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0005)) ;; WM_SIZE
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))      ;; SIZE_RESTORED
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (local.get $packed)) ;; lParam=cx|(cy<<16)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; Drain posted message queue first
      (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
      (then
      ;; Dequeue first message (shift queue down)
      (local.set $tmp (i32.const 0x400))
      (call $gs32 (local.get $msg_ptr) (i32.load (local.get $tmp)))                        ;; hwnd
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.load (i32.add (local.get $tmp) (i32.const 4))))  ;; msg
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.load (i32.add (local.get $tmp) (i32.const 8))))  ;; wParam
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.load (i32.add (local.get $tmp) (i32.const 12)))) ;; lParam
      ;; Shift remaining messages down
      (global.set $post_queue_count (i32.sub (global.get $post_queue_count) (i32.const 1)))
      (if (i32.gt_u (global.get $post_queue_count) (i32.const 0))
      (then (call $memcpy (i32.const 0x400) (i32.const 0x410)
      (i32.mul (global.get $post_queue_count) (i32.const 16)))))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; Phase 0: send WM_PAINT
      (if (i32.eqz (global.get $msg_phase))
      (then
      (global.set $msg_phase (i32.const 1))
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; Phase 1: send WM_ACTIVATE to start game
      (if (i32.eq (global.get $msg_phase) (i32.const 1))
      (then
      (global.set $msg_phase (i32.const 2))
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0006)) ;; WM_ACTIVATE
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 1))      ;; WA_ACTIVE
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $main_hwnd)) ;; lParam (non-zero)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; Poll for input events from the host
      (local.set $packed (call $host_check_input))
      (if (i32.ne (local.get $packed) (i32.const 0))
      (then
      ;; Unpack: msg = low 16 bits, wParam = high 16 bits
      ;; Use hwnd from event if provided, else main_hwnd
      (local.set $tmp (call $host_check_input_hwnd))
      (if (i32.eqz (local.get $tmp))
      (then (local.set $tmp (global.get $main_hwnd))))
      (call $gs32 (local.get $msg_ptr) (local.get $tmp))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4))
      (i32.and (local.get $packed) (i32.const 0xFFFF)))            ;; msg
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8))
      (i32.shr_u (local.get $packed) (i32.const 16)))              ;; wParam
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12))
      (call $host_check_input_lparam))                              ;; lParam
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; No input — deliver WM_PAINT if pending (lowest priority per Win32 spec)
      (if (global.get $paint_pending)
      (then
      (global.set $paint_pending (i32.const 0))
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; No paint — deliver WM_TIMER if timer is active
      (if (global.get $timer_id)
      (then
      (call $gs32 (local.get $msg_ptr) (global.get $timer_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0113)) ;; WM_TIMER
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (global.get $timer_id)) ;; wParam=timerID
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (global.get $timer_callback)) ;; lParam=callback
      (global.set $yield_flag (i32.const 1)) ;; yield to host after each timer
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
      ;; No timer — return WM_NULL
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0))  ;; WM_NULL
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 74: PeekMessageA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 75: DispatchMessageA
      ;; Skip WM_NULL — idle message, don't dispatch to WndProc
      (if (i32.eqz (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
      (then (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      ;; WM_TIMER with callback (lParam != 0): call callback(hwnd, WM_TIMER, timerID, tickcount)
      (if (i32.and (i32.eq (call $gl32 (i32.add (local.get $arg0) (i32.const 4))) (i32.const 0x0113))
      (i32.ne (call $gl32 (i32.add (local.get $arg0) (i32.const 12))) (i32.const 0)))
      (then
      (local.set $tmp (call $gl32 (global.get $esp)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
      ;; Push callback args: GetTickCount, timerID, WM_TIMER, hwnd
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (global.get $tick_count)) ;; dwTime
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))) ;; timerID
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (i32.const 0x0113)) ;; WM_TIMER
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0))) ;; hwnd
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (local.get $tmp))
      (global.set $eip (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))) ;; callback addr
      (global.set $steps (i32.const 0))
      (return)))
      ;; If we have a WndProc, call it with the message
      (if (i32.and (i32.ne (global.get $wndproc_addr) (i32.const 0)) (i32.ne (local.get $arg0) (i32.const 0)))
      (then
      ;; Save the caller's return address before we modify the stack
      (local.set $tmp (call $gl32 (global.get $esp)))
      ;; Pop DispatchMessageA's own frame (ret + MSG* = 8 bytes)
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
      ;; Now push WndProc args: lParam, wParam, msg, hwnd (right to left)
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 12)))) ;; lParam
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 8))))  ;; wParam
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))  ;; msg
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (call $gl32 (local.get $arg0)))                          ;; hwnd
      ;; Push return address — when WndProc returns, go back to DispatchMessage's caller
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (local.get $tmp))
      ;; Jump to WndProc — select based on hwnd
      (if (i32.eq (call $gl32 (local.get $arg0)) (global.get $main_hwnd))
      (then (global.set $eip (global.get $wndproc_addr)))
      (else (if (global.get $wndproc_addr2)
      (then (global.set $eip (global.get $wndproc_addr2)))
      (else (global.set $eip (global.get $wndproc_addr))))))
      (global.set $steps (i32.const 0))
      (return)))
      ;; No WndProc: just return 0
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 76: TranslateAcceleratorA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 77: TranslateMessage
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 78: DefWindowProcA
      ;; WM_CLOSE (0x10): call DestroyWindow(hwnd)
      (if (i32.eq (local.get $arg1) (i32.const 0x0010))
      (then
      ;; DestroyWindow sends WM_DESTROY to WndProc
      ;; For now, just set quit_flag directly since WM_DESTROY→PostQuitMessage
      (global.set $quit_flag (i32.const 1))))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 79: PostQuitMessage
      (global.set $quit_flag (i32.const 1))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 80: PostMessageA
      ;; Queue if room (max 8 messages, 16 bytes each, at WASM addr 0x400)
      (if (i32.lt_u (global.get $post_queue_count) (i32.const 8))
      (then
      (local.set $tmp (i32.add (i32.const 0x400)
      (i32.mul (global.get $post_queue_count) (i32.const 16))))
      (i32.store (local.get $tmp) (local.get $arg0))                         ;; hwnd
      (i32.store (i32.add (local.get $tmp) (i32.const 4)) (local.get $arg1)) ;; msg
      (i32.store (i32.add (local.get $tmp) (i32.const 8)) (local.get $arg2)) ;; wParam
      (i32.store (i32.add (local.get $tmp) (i32.const 12)) (local.get $arg3));; lParam
      (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1)))))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 81: SendMessageA
      ;; Dispatch to WndProc for main window or dialog window
      (if (i32.and (i32.ne (global.get $wndproc_addr) (i32.const 0))
      (i32.or (i32.eq (local.get $arg0) (global.get $main_hwnd))
      (i32.eq (local.get $arg0) (global.get $dlg_hwnd))))
      (then
      ;; Save caller's return address
      (local.set $tmp (call $gl32 (global.get $esp)))
      ;; Pop SendMessageA frame (ret + 4 args = 20 bytes)
      (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
      ;; Push WndProc args: lParam, wParam, msg, hwnd (right to left)
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (local.get $arg3))  ;; lParam
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (local.get $arg2))  ;; wParam
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (local.get $arg1))  ;; msg
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (local.get $arg0))  ;; hwnd
      ;; Push return address
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (local.get $tmp))
      ;; Jump to WndProc — select based on hwnd
      (if (i32.eq (call $gl32 (local.get $arg0)) (global.get $main_hwnd))
      (then (global.set $eip (global.get $wndproc_addr)))
      (else (if (global.get $wndproc_addr2)
      (then (global.set $eip (global.get $wndproc_addr2)))
      (else (global.set $eip (global.get $wndproc_addr))))))
      (global.set $steps (i32.const 0))
      (return)))
      ;; Non-main window or no WndProc: stub — return 0
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 82: SendDlgItemMessageA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 83: DestroyWindow
      ;; Set quit_flag when destroying main or dialog window.
      ;; For mode switches (e.g. calc Scientific), CreateDialogParamA clears quit_flag.
      (if (i32.or (i32.eq (local.get $arg0) (global.get $main_hwnd))
      (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
      (then (global.set $quit_flag (i32.const 1))))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 84: DestroyMenu
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 85: GetDC
      (global.set $eax (i32.const 0x50001)) ;; fake HDC
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 86: GetDeviceCaps
      ;; Return reasonable defaults for common caps
      ;; HORZRES=8, VERTRES=10, LOGPIXELSX=88, LOGPIXELSY=90
      (if (i32.eq (local.get $arg1) (i32.const 8))
      (then (global.set $eax (i32.const 640))))  ;; HORZRES
      (if (i32.eq (local.get $arg1) (i32.const 10))
      (then (global.set $eax (i32.const 480))))  ;; VERTRES
      (if (i32.eq (local.get $arg1) (i32.const 88))
      (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSX
      (if (i32.eq (local.get $arg1) (i32.const 90))
      (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSY
      (if (i32.eq (local.get $arg1) (i32.const 12))
      (then (global.set $eax (i32.const 32))))  ;; BITSPIXEL
      (if (i32.eq (local.get $arg1) (i32.const 14))
      (then (global.set $eax (i32.const 1))))   ;; PLANES
      (if (i32.eq (local.get $arg1) (i32.const 24))
      (then (global.set $eax (i32.const 256)))) ;; NUMCOLORS (0x18) — not exact but close
      (if (i32.eq (local.get $arg1) (i32.const 40))
      (then (global.set $eax (i32.const -1))))  ;; NUMCOLORS (0x28) — -1 = >256 colors
      (if (i32.eq (local.get $arg1) (i32.const 42))
      (then (global.set $eax (i32.const 24))))  ;; COLORRES (0x2A) — 24-bit color
      (if (i32.eq (local.get $arg1) (i32.const 104))
      (then (global.set $eax (i32.const 32))))  ;; SIZEPALETTE (0x68)
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 87: GetMenu
      (global.set $eax (i32.const 0x40001)) ;; fake HMENU
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 88: GetSubMenu
      (global.set $eax (i32.const 0x40002))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 89: GetSystemMenu
      ;; Could be GetSystemMenu or GetSystemMetrics — check w2
      (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 9))) (i32.const 0x65)) ;; "e" in Menu
      (then (global.set $eax (i32.const 0x40003))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
      ;; GetSystemMetrics(1) — return reasonable Win98 values for 640x480
      ;; SM_CXSCREEN=0, SM_CYSCREEN=1, SM_CXFULLSCREEN=16, SM_CYFULLSCREEN=17
      ;; SM_CXMAXIMIZED=61(0x3D), SM_CYMAXIMIZED=62(0x3E)
      ;; SM_CXFRAME=32, SM_CYFRAME=33, SM_CYCAPTION=4, SM_CYMENU=15
      (if (i32.eq (local.get $arg0) (i32.const 0))  ;; SM_CXSCREEN
      (then (global.set $eax (i32.const 640))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 1))  ;; SM_CYSCREEN
      (then (global.set $eax (i32.const 480))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 4))  ;; SM_CYCAPTION
      (then (global.set $eax (i32.const 19))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 5))  ;; SM_CXBORDER
      (then (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 6))  ;; SM_CYBORDER
      (then (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 7))  ;; SM_CXFIXEDFRAME (SM_CXDLGFRAME)
      (then (global.set $eax (i32.const 3))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 8))  ;; SM_CYFIXEDFRAME
      (then (global.set $eax (i32.const 3))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 15)) ;; SM_CYMENU
      (then (global.set $eax (i32.const 19))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 16)) ;; SM_CXFULLSCREEN
      (then (global.set $eax (i32.const 640))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 17)) ;; SM_CYFULLSCREEN
      (then (global.set $eax (i32.const 434))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 32)) ;; SM_CXFRAME (SM_CXSIZEFRAME)
      (then (global.set $eax (i32.const 4))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 33)) ;; SM_CYFRAME
      (then (global.set $eax (i32.const 4))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 0x3D)) ;; SM_CXMAXIMIZED
      (then (global.set $eax (i32.const 648))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 0x3E)) ;; SM_CYMAXIMIZED
      (then (global.set $eax (i32.const 488))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 90: GetSystemMetrics (actual slot used by imports)
      (if (i32.eq (local.get $arg0) (i32.const 0))  ;; SM_CXSCREEN
      (then (global.set $eax (i32.const 640))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 1))  ;; SM_CYSCREEN
      (then (global.set $eax (i32.const 480))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 4))  ;; SM_CYCAPTION
      (then (global.set $eax (i32.const 19))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 5))  ;; SM_CXBORDER
      (then (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 6))  ;; SM_CYBORDER
      (then (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 7))  ;; SM_CXFIXEDFRAME
      (then (global.set $eax (i32.const 3))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 8))  ;; SM_CYFIXEDFRAME
      (then (global.set $eax (i32.const 3))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 15)) ;; SM_CYMENU
      (then (global.set $eax (i32.const 19))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 16)) ;; SM_CXFULLSCREEN
      (then (global.set $eax (i32.const 640))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 17)) ;; SM_CYFULLSCREEN
      (then (global.set $eax (i32.const 434))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 32)) ;; SM_CXFRAME
      (then (global.set $eax (i32.const 4))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 33)) ;; SM_CYFRAME
      (then (global.set $eax (i32.const 4))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 0x3D)) ;; SM_CXMAXIMIZED
      (then (global.set $eax (i32.const 648))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (if (i32.eq (local.get $arg0) (i32.const 0x3E)) ;; SM_CYMAXIMIZED
      (then (global.set $eax (i32.const 488))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 91: GetClientRect
      ;; Fill RECT with client area (use window dims minus frame)
      (call $gs32 (local.get $arg1) (i32.const 0))       ;; left
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))   ;; top
      (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.sub (global.get $main_win_cx) (i32.const 6))) ;; right = cx - frame
      (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.sub (global.get $main_win_cy) (i32.const 45)));; bottom = cy - caption - frame
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 92: GetWindowTextA
      ;; Return empty string
      (if (i32.gt_u (local.get $arg2) (i32.const 0))
      (then (call $gs8 (local.get $arg1) (i32.const 0))))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 93: GetWindowRect
      (call $gs32 (local.get $arg1) (i32.const 0))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 640))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 480))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 94: GetDlgCtrlID
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 95: GetDlgItemTextA
      (if (i32.gt_u (local.get $arg3) (i32.const 0))
      (then (call $gs8 (local.get $arg2) (i32.const 0))))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 96: GetDlgItem
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 97: GetCursorPos
      (call $gs32 (local.get $arg0) (i32.const 0))
      (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 98: GetLastActivePopup
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 99: GetFocus
      (global.set $eax (global.get $main_hwnd))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 100: ReleaseDC
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 101: SetWindowLongA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 102: SetWindowTextA
      (call $host_set_window_text (local.get $arg0) (call $g2w (local.get $arg1)))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 103: SetDlgItemTextA
      (call $host_set_dlg_item_text
      (local.get $arg0)                          ;; hDlg
      (local.get $arg1)                          ;; nIDDlgItem
      (call $g2w (local.get $arg2)))             ;; lpString → WASM ptr
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 104: SetDlgItemInt
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 105: SetForegroundWindow
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 106: SetCursor
      (global.set $eax (i32.const 0x20001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 107: SetFocus
      (global.set $eax (global.get $main_hwnd))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 108: LoadCursorA
      (global.set $eax (i32.const 0x20001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 109: LoadIconA
      (global.set $eax (i32.const 0x20002))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 110: LoadStringA
      ;; Call host to write string from resource JSON into guest buffer
      (global.set $eax (call $host_load_string
      (local.get $arg1)                ;; string ID
      (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
      (local.get $arg3)))              ;; max chars
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 111: LoadAcceleratorsA
      (global.set $haccel (i32.const 0x60001))
      (global.set $eax (i32.const 0x60001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 112: EnableWindow
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 113: EnableMenuItem
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 114: EndDialog
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 115: InvalidateRect
      (global.set $paint_pending (i32.const 1))
      (call $host_invalidate (local.get $arg0))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 116: FillRect
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 117: FrameRect
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 118: LoadBitmapA
      ;; arg1 = resource ID (MAKEINTRESOURCE value, low 16 bits)
      (local.set $tmp (call $host_gdi_load_bitmap (i32.and (local.get $arg1) (i32.const 0xFFFF))))
      ;; If host couldn't find it, return a fake 32x32 bitmap
      (if (i32.eqz (local.get $tmp))
      (then (local.set $tmp (call $host_gdi_create_compat_bitmap (i32.const 0) (i32.const 32) (i32.const 32)))))
      (global.set $eax (local.get $tmp))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 119: OpenIcon
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 120: MoveWindow
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 121: CheckMenuRadioItem
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 122: CheckMenuItem
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 123: CheckRadioButton
      (call $host_check_radio_button (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 124: CheckDlgButton
      (call $host_check_dlg_button (local.get $arg0) (local.get $arg1) (local.get $arg2))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 125: CharNextA
      ;; Return ptr+1 (simple ANSI impl)
      (if (i32.eqz (call $gl8 (local.get $arg0)))
      (then (global.set $eax (local.get $arg0)))
      (else (global.set $eax (i32.add (local.get $arg0) (i32.const 1)))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 126: CharPrevA
      ;; Return max(start, ptr-1)
      (if (i32.le_u (local.get $arg1) (local.get $arg0))
      (then (global.set $eax (local.get $arg0)))
      (else (global.set $eax (i32.sub (local.get $arg1) (i32.const 1)))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 127: IsDialogMessageA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 128: IsIconic
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 129: ChildWindowFromPoint
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 130: ScreenToClient
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 131: TabbedTextOutA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 36))) (return)
    (return)
    ) ;; 132: WinHelpA
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 133: IsChild
      (global.set $eax (if (result i32) (i32.and
      (i32.ne (global.get $dlg_hwnd) (i32.const 0))
      (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
      (then (i32.const 1)) (else (i32.const 0))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 134: GetSysColorBrush
      (global.set $eax (i32.const 0x30010)) ;; fake HBRUSH
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 135: GetSysColor
      ;; Return reasonable defaults for common colors
      ;; COLOR_WINDOW=5 → white, COLOR_BTNFACE=15 → 0xC0C0C0
      (if (i32.eq (local.get $arg0) (i32.const 5))
      (then (global.set $eax (i32.const 0x00FFFFFF)))
      (else (if (i32.eq (local.get $arg0) (i32.const 15))
      (then (global.set $eax (i32.const 0x00C0C0C0)))
      (else (global.set $eax (i32.const 0x00C0C0C0))))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 136: DialogBoxParamA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 137: LoadMenuA
      (global.set $eax (i32.or (i32.const 0x40000) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 138: TrackPopupMenuEx
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 139: OffsetRect
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 140: MapWindowPoints
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 141: SetWindowPos
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)
    (return)
    ) ;; 142: DrawTextA
      (global.set $eax (i32.const 16)) ;; return text height
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 143: DrawEdge
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 144: GetClipboardData
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 145: SelectObject
      (global.set $eax (call $host_gdi_select_object (local.get $arg0) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 146: DeleteObject
      (global.set $eax (call $host_gdi_delete_object (local.get $arg0)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 147: DeleteDC
      (global.set $eax (call $host_gdi_delete_dc (local.get $arg0)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 148: CreatePen
      (global.set $eax (call $host_gdi_create_pen (local.get $arg0) (local.get $arg1) (local.get $arg2)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 149: CreateSolidBrush
      (global.set $eax (call $host_gdi_create_solid_brush (local.get $arg0)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 150: CreateCompatibleDC
      (global.set $eax (call $host_gdi_create_compat_dc (local.get $arg0)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 151: CreateCompatibleBitmap
      (global.set $eax (call $host_gdi_create_compat_bitmap (local.get $arg0) (local.get $arg1) (local.get $arg2)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 152: GetViewportOrgEx
      ;; Fill POINT with (0,0)
      (if (i32.ne (local.get $arg1) (i32.const 0))
      (then
      (call $gs32 (local.get $arg1) (i32.const 0))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 153: Rectangle
      (global.set $eax (call $host_gdi_rectangle
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $main_hwnd)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 154: MoveToEx
      ;; Save old position to lpPoint (arg3) if non-null
      (global.set $eax (call $host_gdi_move_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 155: LineTo
      (global.set $eax (call $host_gdi_line_to (local.get $arg0) (local.get $arg1) (local.get $arg2) (global.get $main_hwnd)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 156: Ellipse
      (global.set $eax (call $host_gdi_ellipse
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $main_hwnd)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 157: Arc
      (global.set $eax (call $host_gdi_arc
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
      (global.get $main_hwnd)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
    (return)
    ) ;; 158: BitBlt
      (global.set $eax (call $host_gdi_bitblt
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
      (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
      (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
      (global.get $main_hwnd)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)
    (return)
    ) ;; 159: PatBlt — hdc(arg0), x(arg1), y(arg2), w=[esp+16], h=[esp+20], rop=[esp+24]
      (call $host_gdi_rectangle (local.get $arg0) (local.get $arg1) (local.get $arg2)
        (i32.add (local.get $arg1) (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
        (i32.add (local.get $arg2) (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
        (global.get $main_hwnd))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 160: CreateBitmap
      (global.set $eax (call $host_gdi_create_compat_bitmap (i32.const 0) (local.get $arg0) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 161: TextOutA
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 162: GetStockObject
      (global.set $eax (i32.const 0x30002))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 163: GetObjectA
      (if (i32.gt_u (local.get $arg1) (i32.const 0))
      (then (call $zero_memory (call $g2w (local.get $arg2)) (local.get $arg1))))
      ;; Try to fill BITMAP struct if it's a bitmap object
      (local.set $tmp (call $host_gdi_get_object_w (local.get $arg0)))
      (if (i32.ne (local.get $tmp) (i32.const 0))
      (then
      ;; BITMAP: bmType(0,4), bmWidth(+4,4), bmHeight(+8,4), bmWidthBytes(+12,4), bmPlanes(+16,2), bmBitsPixel(+18,2), bmBits(+20,4)
      (if (i32.ge_u (local.get $arg1) (i32.const 24))
      (then
      (call $gs32 (i32.add (local.get $arg2) (i32.const 4)) (local.get $tmp))  ;; bmWidth
      (call $gs32 (i32.add (local.get $arg2) (i32.const 8)) (call $host_gdi_get_object_h (local.get $arg0))) ;; bmHeight
      (call $gs32 (i32.add (local.get $arg2) (i32.const 12))
      (i32.mul (local.get $tmp) (i32.const 4))) ;; bmWidthBytes (assuming 32bpp)
      (call $gs16 (i32.add (local.get $arg2) (i32.const 16)) (i32.const 1))    ;; bmPlanes
      (call $gs16 (i32.add (local.get $arg2) (i32.const 18)) (i32.const 32))   ;; bmBitsPixel
      ))))
      (global.set $eax (local.get $arg1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 164: GetTextMetricsA
      ;; Fill TEXTMETRIC with reasonable defaults
      (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 56))
      (call $gs32 (local.get $arg1) (i32.const 16))           ;; tmHeight
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))  ;; tmAscent (unused detail)
      (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 8)) ;; tmAveCharWidth
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 165: GetTextExtentPointA
      ;; Fill SIZE: cx = count*8, cy = 16
      (call $gs32 (local.get $arg3) (i32.mul (local.get $arg2) (i32.const 8)))  ;; cx
      (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (i32.const 16))     ;; cy
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 166: GetTextCharset
      (global.set $eax (i32.const 0)) ;; ANSI_CHARSET
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 167: CreateFontIndirectA
      (global.set $eax (i32.const 0x30003))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 168: CreateFontA
      (global.set $eax (i32.const 0x30003))
      (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)
    (return)
    ) ;; 169: CreateDCA
      (global.set $eax (i32.const 0x50002))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 170: SetAbortProc
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 171: SetBkColor
      (global.set $eax (i32.const 0x00FFFFFF)) ;; prev color
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 172: SetBkMode
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 173: SetTextColor
      (global.set $eax (i32.const 0x00000000)) ;; prev color (black)
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 174: SetMenu
      (call $host_set_menu
      (local.get $arg0)                                       ;; hWnd
      (i32.and (local.get $arg1) (i32.const 0xFFFF)))         ;; resource ID from HMENU
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 175: SetMapMode
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 176: SetWindowExtEx
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 177: LPtoDP
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 178: StartDocA
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 179: StartPage
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 180: EndPage
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 181: EndPaint
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 182: EndDoc
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 183: AbortDoc
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 184: SetCapture
      (global.set $eax (i32.const 0)) ;; prev capture hwnd (none)
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 185: ReleaseCapture
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 186: ShowCursor
      (global.set $eax (i32.const 1)) ;; display count
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 187: KillTimer
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 188: SetTimer
      (global.set $timer_id (local.get $arg1))
      (global.set $timer_hwnd (local.get $arg0))
      (global.set $timer_callback (local.get $arg3))
      (global.set $eax (local.get $arg1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 189: FindWindowA
      (global.set $eax (i32.const 0)) ;; not found
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 190: BringWindowToTop
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 191: GetPrivateProfileIntA
      (global.set $eax (local.get $arg2)) ;; return nDefault
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 192: WritePrivateProfileStringA
      (global.set $eax (i32.const 1)) ;; success
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 193: ShellExecuteA
      (global.set $eax (i32.const 33)) ;; > 32 means success
      (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)
    (return)
    ) ;; 194: ShellAboutA
      (global.set $eax (call $host_shell_about (local.get $arg0) (call $g2w (local.get $arg1))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 195: SHGetSpecialFolderPathA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 196: DragAcceptFiles
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 197: DragQueryFileA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 198: DragFinish
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 199: GetOpenFileNameA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 200: GetFileTitleA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 201: ChooseFontA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 202: FindTextA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 203: PageSetupDlgA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 204: CommDlgExtendedError
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 205: exit
      (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
      (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)
    (return)
    ) ;; 206: _exit
      (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
      (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)
    (return)
    ) ;; 207: __getmainargs
      ;; arg0=&argc, arg1=&argv, arg2=&envp
      (call $gs32 (local.get $arg0) (i32.const 1))     ;; argc = 1
      ;; Allocate a fake argv array: argv[0] = ptr to "CALC", argv[1] = 0
      (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
      (then
      (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 32)))
      ;; Write "CALC\0" at acmdln_ptr
      (i32.store (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 0x434C4143)) ;; "CALC"
      (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 4)) (i32.const 0))
      ;; Write argv array at acmdln_ptr+8: [acmdln_ptr, 0]
      (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 8)) (global.get $msvcrt_acmdln_ptr))
      (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 12)) (i32.const 0))
      ;; envp at acmdln_ptr+16: [0]
      (i32.store (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 16)) (i32.const 0))))
      (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 8)))  ;; argv
      (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 16))) ;; envp
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 208: __p__fmode
      (if (i32.eqz (global.get $msvcrt_fmode_ptr))
      (then (global.set $msvcrt_fmode_ptr (call $heap_alloc (i32.const 4)))
      (call $gs32 (global.get $msvcrt_fmode_ptr) (i32.const 0))))
      (global.set $eax (global.get $msvcrt_fmode_ptr))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 209: __p__commode
      (if (i32.eqz (global.get $msvcrt_commode_ptr))
      (then (global.set $msvcrt_commode_ptr (call $heap_alloc (i32.const 4)))
      (call $gs32 (global.get $msvcrt_commode_ptr) (i32.const 0))))
      (global.set $eax (global.get $msvcrt_commode_ptr))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 210: _initterm
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 211: _controlfp
      (global.set $eax (i32.const 0x0009001F)) ;; default FP control word
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 212: _strrev
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
    (return)
    ) ;; 213: toupper
      ;; Simple ASCII toupper
      (if (i32.and (i32.ge_u (local.get $arg0) (i32.const 0x61)) (i32.le_u (local.get $arg0) (i32.const 0x7A)))
      (then (global.set $eax (i32.sub (local.get $arg0) (i32.const 0x20))))
      (else (global.set $eax (local.get $arg0))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 214: memmove
      (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 215: strchr
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
    (return)
    ) ;; 216: _XcptFilter
      (nop)
    (return)
    ) ;; 217: _CxxThrowException
      (local.set $tmp (call $gl32 (global.get $fs_base))) ;; SEH chain head
      (block $found (loop $lp
      (br_if $found (i32.or (i32.eq (local.get $tmp) (i32.const 0xFFFFFFFF))
      (i32.eqz (local.get $tmp))))
      ;; SEH record at $tmp: [+0]=next, [+4]=handler
      (local.set $msg_ptr (call $gl32 (i32.add (local.get $tmp) (i32.const 4)))) ;; handler addr
      (if (i32.and (i32.ge_u (local.get $msg_ptr) (global.get $image_base))
      (i32.lt_u (local.get $msg_ptr) (i32.add (global.get $image_base) (i32.const 0x200000))))
      (then
      ;; Check for __ehhandler stub: B8 <FuncInfo addr> E9 <jmp>
      (if (i32.eq (i32.load8_u (call $g2w (local.get $msg_ptr))) (i32.const 0xB8))
      (then
      ;; Extract FuncInfo address from MOV EAX, <addr>
      (local.set $name_rva (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 1)))))
      ;; Verify FuncInfo magic (0x19930520-0x19930523)
      (if (i32.eq (i32.and (i32.load (call $g2w (local.get $name_rva))) (i32.const 0xFFFFFFFC))
      (i32.const 0x19930520))
      (then
      ;; FuncInfo: [+0]=magic, [+4]=nUnwind, [+8]=unwindMap,
      ;;           [+12]=nTryBlocks, [+16]=tryBlockMap
      ;; Derive frame EBP: _EH_prolog puts SEH record at EBP-C
      (local.set $w0 (i32.add (local.get $tmp) (i32.const 12))) ;; frame EBP
      ;; Read trylevel from [EBP-4]
      (local.set $w1 (i32.load (call $g2w (i32.sub (local.get $w0) (i32.const 4)))))
      ;; Walk try blocks to find one matching trylevel
      (local.set $w2 (i32.load (call $g2w (i32.add (local.get $name_rva) (i32.const 12))))) ;; nTryBlocks
      (local.set $msg_ptr (i32.load (call $g2w (i32.add (local.get $name_rva) (i32.const 16))))) ;; tryBlockMap
      (block $tb_done (loop $tb_lp
      (br_if $tb_done (i32.le_s (local.get $w2) (i32.const 0)))
      ;; TryBlockMapEntry: [+0]=tryLow, [+4]=tryHigh, [+8]=catchHigh,
      ;;                   [+12]=nCatches, [+16]=catchArray
      (if (i32.and
      (i32.le_s (i32.load (call $g2w (local.get $msg_ptr))) (local.get $w1)) ;; tryLow <= trylevel
      (i32.ge_s (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 4)))) (local.get $w1))) ;; tryHigh >= trylevel
      (then
      ;; Found matching try block! Get first catch handler.
      ;; HandlerType: [+0]=flags, [+4]=typeInfo, [+8]=dispCatchObj, [+12]=handler
      (local.set $arg2 (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 16))))) ;; catchArray
      (local.set $arg3 (i32.load (call $g2w (i32.add (local.get $arg2) (i32.const 8))))) ;; dispCatchObj
      (local.set $arg4 (i32.load (call $g2w (i32.add (local.get $arg2) (i32.const 12))))) ;; handler addr
      ;; Update trylevel to catchHigh (state after catch)
      (call $gs32 (call $g2w (i32.sub (local.get $w0) (i32.const 4)))
      (i32.load (call $g2w (i32.add (local.get $msg_ptr) (i32.const 8))))) ;; catchHigh
      ;; Restore SEH chain: unwind to this frame's prev
      (call $gs32 (global.get $fs_base) (call $gl32 (local.get $tmp)))
      ;; Set up catch context
      (global.set $ebp (local.get $w0))
      (global.set $esp (local.get $tmp)) ;; ESP = SEH record = EBP-C
      ;; Store exception object at [EBP+dispCatchObj] if nonzero
      (if (local.get $arg3)
      (then (call $gs32 (call $g2w (i32.add (local.get $w0) (local.get $arg3)))
      (local.get $arg0))))
      ;; Push catch-return thunk as return address for funclet
      (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
      (call $gs32 (global.get $esp) (global.get $catch_ret_thunk))
      ;; Jump to catch funclet (returns continuation addr in EAX)
      (global.set $eip (local.get $arg4))
      (return)))
      (local.set $msg_ptr (i32.add (local.get $msg_ptr) (i32.const 20))) ;; next try block
      (local.set $w2 (i32.sub (local.get $w2) (i32.const 1)))
      (br $tb_lp)))
      ))))))
      ;; Move to next SEH record
      (local.set $tmp (call $gl32 (local.get $tmp)))
      (br $lp)))
      ;; No catch found — return from throw (skip exception as fallback)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 218: lstrlenA
      (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 219: lstrcpyA
      (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 220: lstrcatA
      (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 221: lstrcpynA
      (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 222: lstrcmpA
      (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 223: RegCloseKey
      (call $dispatch_reg (local.get $name_ptr))
    (return)
    ) ;; 224: RegCreateKeyA
      (call $dispatch_reg (local.get $name_ptr))
    (return)
    ) ;; 225: RegQueryValueExA
      (call $dispatch_reg (local.get $name_ptr))
    (return)
    ) ;; 226: RegSetValueExA
      (call $dispatch_reg (local.get $name_ptr))
    (return)
    ) ;; 227: LocalAlloc
      (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 228: LocalFree
      (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 229: LocalLock
      (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 230: LocalUnlock
      (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 231: LocalReAlloc
      (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 232: GlobalAlloc
      (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 233: GlobalFree
      (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 234: GlobalLock
      (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 235: GlobalUnlock
      (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 236: GlobalReAlloc
      (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 237: GlobalSize
      (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 238: GlobalCompact
      (global.set $eax (i32.const 0x100000))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (return)
    ) ;; 239: RegOpenKeyA
      (call $dispatch_reg (local.get $name_ptr))
    (return)
    ) ;; 240: RegOpenKeyExA
      ;; stub
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    (return)
    ) ;; 241: RegisterClassExA
      (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 13))) (i32.const 0x45)) ;; 'E' = ExA
      (then ;; WNDCLASSEX: lpfnWndProc at +8
      (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))))
      (else ;; WNDCLASSA: lpfnWndProc at +4
      (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))))
      ;; Store first wndproc as main, subsequent as child
      (if (i32.eqz (global.get $wndproc_addr))
      (then (global.set $wndproc_addr (local.get $tmp)))
      (else (global.set $wndproc_addr2 (local.get $tmp))))
      (global.set $eax (i32.const 0xC001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 242: RegisterClassA
      (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 13))) (i32.const 0x45)) ;; 'E' = ExA
      (then ;; WNDCLASSEX: lpfnWndProc at +8
      (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))))
      (else ;; WNDCLASSA: lpfnWndProc at +4
      (local.set $tmp (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))))
      ;; Store first wndproc as main, subsequent as child
      (if (i32.eqz (global.get $wndproc_addr))
      (then (global.set $wndproc_addr (local.get $tmp)))
      (else (global.set $wndproc_addr2 (local.get $tmp))))
      (global.set $eax (i32.const 0xC001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 243: BeginPaint
      ;; Fill PAINTSTRUCT minimally
      (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 64))
      (call $gs32 (local.get $arg1) (i32.const 0x50001)) ;; hdc
      (global.set $eax (i32.const 0x50001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 244: OpenClipboard
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (return)
    ) ;; 245: CloseClipboard
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (return)
    ) ;; 246: IsClipboardFormatAvailable
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (return)
    ) ;; 247: GetEnvironmentStringsW
      ;; Return L"A=B\0\0" (UTF-16LE) — must be non-empty so CRT sets _wenviron
      (local.set $tmp (call $heap_alloc (i32.const 16)))
      (call $gs16 (local.get $tmp) (i32.const 0x41))
      (call $gs16 (i32.add (local.get $tmp) (i32.const 2)) (i32.const 0x3D))
      (call $gs16 (i32.add (local.get $tmp) (i32.const 4)) (i32.const 0x42))
      (call $gs16 (i32.add (local.get $tmp) (i32.const 6)) (i32.const 0))
      (call $gs16 (i32.add (local.get $tmp) (i32.const 8)) (i32.const 0))
      (global.set $eax (local.get $tmp))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 248: GetSaveFileNameA
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 249: SetViewportExtEx
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 250: lstrcmpiA
      (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (return)
    ) ;; 251: FreeEnvironmentStringsA
      ;; stub
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (return)
    ) ;; 252: FreeEnvironmentStringsW
      ;; stub
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
    (return)
    ) ;; 253: GetVersion
      ;; Return Windows 98: major=4, minor=10 → 0x0A040000 → low word=version, high=build
      ;; Format: low byte=major, next byte=minor, high word=build
      (global.set $eax (i32.const 0xC0000A04)) ;; Win98: 4.10, build 0xC000
      (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (return)
    ) ;; 254: GetTextExtentPoint32A
      ;; stub
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
    (return)
    ) ;; 255: wsprintfA
      ;; wsprintfA(buf, fmt, ...) — cdecl, caller cleans stack
      (global.set $eax (call $wsprintf_impl
        (local.get $arg0) (local.get $arg1) (i32.add (global.get $esp) (i32.const 12))))
      ;; cdecl: only pop return address
      (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    (return)
    ) ;; 256: GetPrivateProfileStringA
      ;; stub
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
    (return)
    ) ;; 257: __wgetmainargs
      ;; arg0=&argc, arg1=&argv, arg2=&envp (wide versions)
      (call $gs32 (local.get $arg0) (i32.const 1))     ;; argc = 1
      (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
      (then
        (global.set $msvcrt_wcmdln_ptr (call $heap_alloc (i32.const 64)))
        ;; Write L"PAINT\0" at wcmdln_ptr (UTF-16LE)
        (call $gs16 (global.get $msvcrt_wcmdln_ptr) (i32.const 0x50))        ;; P
        (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 2)) (i32.const 0x41))  ;; A
        (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 4)) (i32.const 0x49))  ;; I
        (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 6)) (i32.const 0x4E))  ;; N
        (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 8)) (i32.const 0x54))  ;; T
        (call $gs16 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 10)) (i32.const 0))    ;; NUL
        ;; argv array at +16: [ptr_to_string, 0]
        (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 16)) (global.get $msvcrt_wcmdln_ptr))
        (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 20)) (i32.const 0))
        ;; envp at +24: [0]
        (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 24)) (i32.const 0))))
      (call $gs32 (local.get $arg1) (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 16)))
      (call $gs32 (local.get $arg2) (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 24)))
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 258: __p__wcmdln
      (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
      (then
        (global.set $msvcrt_wcmdln_ptr (call $heap_alloc (i32.const 64)))
        (call $gs16 (global.get $msvcrt_wcmdln_ptr) (i32.const 0))
        ;; Store ptr-to-ptr at +32
        (call $gs32 (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 32)) (global.get $msvcrt_wcmdln_ptr))))
      (global.set $eax (i32.add (global.get $msvcrt_wcmdln_ptr) (i32.const 32)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 259: __p__acmdln
      (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
      (then
        (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 32)))
        (i32.store (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 0x4E494150)) ;; "PAIN"
        (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 4)) (i32.const 0x54)) ;; "T"
        (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 5)) (i32.const 0))
        ;; ptr-to-ptr at +8
        (call $gs32 (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 8)) (global.get $msvcrt_acmdln_ptr))))
      (global.set $eax (i32.add (global.get $msvcrt_acmdln_ptr) (i32.const 8)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 260: __set_app_type
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 261: __setusermatherr
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 262: _adjust_fdiv
      ;; Return pointer to a 0 dword (no FDIV bug)
      (if (i32.eqz (global.get $msvcrt_fmode_ptr))
        (then (global.set $msvcrt_fmode_ptr (call $heap_alloc (i32.const 4)))))
      (global.set $eax (global.get $msvcrt_fmode_ptr))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 263: free
      (call $heap_free (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 264: malloc
      (global.set $eax (call $heap_alloc (local.get $arg0)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 265: calloc
      (local.set $tmp (i32.mul (local.get $arg0) (local.get $arg1)))
      (global.set $eax (call $heap_alloc (local.get $tmp)))
      (call $zero_memory (call $g2w (global.get $eax)) (local.get $tmp))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 266: rand
      (global.set $rand_seed (i32.add (i32.mul (global.get $rand_seed) (i32.const 1103515245)) (i32.const 12345)))
      (global.set $eax (i32.and (i32.shr_u (global.get $rand_seed) (i32.const 16)) (i32.const 0x7FFF)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 267: srand
      (global.set $rand_seed (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 268: _purecall
      (call $host_exit (i32.const 3))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 269: _onexit
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 270: __dllonexit
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 271: _splitpath — stub
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)
    (return)
    ) ;; 272: _wcsicmp
      (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 273: _wtoi — wide string to int
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
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 274: _itow — int to wide string (stub: write "0")
      (call $gs16 (local.get $arg1) (i32.const 0x30))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 2)) (i32.const 0))
      (global.set $eax (local.get $arg1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 275: wcscmp
      (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 276: wcsncpy
      (local.set $i (i32.const 0))
      (block $d (loop $l
        (br_if $d (i32.ge_u (local.get $i) (local.get $arg2)))
        (local.set $v (call $gl16 (i32.add (local.get $arg1) (i32.shl (local.get $i) (i32.const 1)))))
        (call $gs16 (i32.add (local.get $arg0) (i32.shl (local.get $i) (i32.const 1))) (local.get $v))
        (br_if $d (i32.eqz (local.get $v)))
        (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 277: wcslen
      (global.set $eax (call $guest_wcslen (local.get $arg0)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 278: memset
      (call $zero_memory (call $g2w (local.get $arg0)) (local.get $arg2))
      ;; TODO: handle non-zero fill byte
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 279: memcpy
      (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 280: __CxxFrameHandler — C++ exception frame handler (stub, return 1=ExceptionContinueSearch)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 281: _global_unwind2
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 282: _getdcwd — stub: return empty string
      (if (local.get $arg1)
        (then (call $gs8 (local.get $arg1) (i32.const 0))))
      (global.set $eax (local.get $arg1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 283: GetModuleHandleW — same as A version, return image_base
      (global.set $eax (global.get $image_base))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 284: GetModuleFileNameW — write L"C:\PAINT.EXE\0"
      (call $gs16 (local.get $arg1) (i32.const 0x43))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 2)) (i32.const 0x3A))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0x5C))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 6)) (i32.const 0x50))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 0x41))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 10)) (i32.const 0x49))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 0x4E))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 14)) (i32.const 0x54))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 16)) (i32.const 0x2E))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 18)) (i32.const 0x45))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 0x58))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 22)) (i32.const 0x45))
      (call $gs16 (i32.add (local.get $arg1) (i32.const 24)) (i32.const 0))
      (global.set $eax (i32.const 12))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 285: GetCommandLineW
      ;; Return pointer to wide command line string
      (if (i32.eqz (global.get $msvcrt_wcmdln_ptr))
      (then
        (global.set $msvcrt_wcmdln_ptr (call $heap_alloc (i32.const 64)))
        (call $gs16 (global.get $msvcrt_wcmdln_ptr) (i32.const 0))))
      (global.set $eax (global.get $msvcrt_wcmdln_ptr))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 286: CreateWindowExW — delegate to existing CreateWindowEx logic
      ;; For now stub: return 0 (window creation needs more work for W variant)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)
    (return)
    ) ;; 287: RegisterClassW — stub, return 1
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 288: RegisterClassExW — stub, return 1
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 289: DefWindowProcW — delegate to existing DefWindowProc
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 290: LoadCursorW — return fake handle
      (global.set $eax (i32.const 0x60001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 291: LoadIconW — return fake handle
      (global.set $eax (i32.const 0x70001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 292: LoadMenuW — return fake handle
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 293: MessageBoxW — stub, return 1 (IDOK)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 294: SetWindowTextW — stub
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 295: GetWindowTextW — stub, return 0
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 296: SendMessageW — stub, return 0
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 297: PostMessageW — stub, return 1
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 298: SetErrorMode
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 299: GetCurrentThreadId
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 300: LoadLibraryW — stub, return fake handle
      (global.set $eax (i32.const 0x7FFE0000))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 301: GetStartupInfoW — zero-fill the struct
      (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 68))
      ;; Set cb = 68 (sizeof STARTUPINFOW)
      (call $gs32 (local.get $arg0) (i32.const 68))
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 302: GetKeyState
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 303: GetParent
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 304: GetWindow
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 305: IsWindow
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 306: GetClassInfoW — stub, return 0
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 307: SetWindowLongW — stub, return 0 (previous value)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 308: GetWindowLongW — stub, return 0
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 309: InitCommonControlsEx — return 1 (success)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 310: OleInitialize — return S_OK (0)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 311: CoTaskMemFree — no-op
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 312: SaveDC
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 313: RestoreDC
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 314: GetTextMetricsW — zero-fill, return 1
      (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 60))
      ;; Set tmHeight=16, tmAveCharWidth=8
      (call $gs32 (local.get $arg1) (i32.const 16))
      (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 8))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 315: CreateFontIndirectW — return fake font handle
      (global.set $eax (i32.const 0x90001))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 316: SetStretchBltMode
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 317: GetPixel
      (global.set $eax (i32.const 0)) ;; black
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 318: SetPixel
      (global.set $eax (local.get $arg3)) ;; return color
      (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)
    (return)
    ) ;; 319: SetROP2
      (global.set $eax (i32.const 13)) ;; R2_COPYPEN
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 320: lstrlenW
      (global.set $eax (call $guest_wcslen (local.get $arg0)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 321: lstrcpyW
      (call $guest_wcscpy (local.get $arg0) (local.get $arg1))
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 322: lstrcmpW
      (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 323: lstrcmpiW
      (global.set $eax (call $guest_wcsicmp (local.get $arg0) (local.get $arg1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 324: CharNextW — advance by one wide char
      (global.set $eax (i32.add (local.get $arg0) (i32.const 2)))
      (if (i32.eqz (call $gl16 (local.get $arg0)))
        (then (global.set $eax (local.get $arg0))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 325: wsprintfW — wide sprintf stub (return 0)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 326: TlsAlloc — return next TLS index
      (if (i32.eqz (global.get $tls_slots))
        (then
          (global.set $tls_slots (call $heap_alloc (i32.const 256)))
          (call $zero_memory (call $g2w (global.get $tls_slots)) (i32.const 256))))
      (global.set $eax (global.get $tls_next_index))
      (global.set $tls_next_index (i32.add (global.get $tls_next_index) (i32.const 1)))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 327: TlsGetValue(index)
      (if (i32.eqz (global.get $tls_slots))
        (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
      (global.set $eax (call $gl32 (i32.add (global.get $tls_slots) (i32.shl (local.get $arg0) (i32.const 2)))))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 328: TlsSetValue(index, value)
      (if (i32.eqz (global.get $tls_slots))
        (then
          (global.set $tls_slots (call $heap_alloc (i32.const 256)))
          (call $zero_memory (call $g2w (global.get $tls_slots)) (i32.const 256))))
      (call $gs32 (i32.add (global.get $tls_slots) (i32.shl (local.get $arg0) (i32.const 2))) (local.get $arg1))
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 329: TlsFree(index) — no-op, return 1
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 330: InitializeCriticalSection(ptr) — no-op (single-threaded)
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 331: EnterCriticalSection(ptr) — no-op
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 332: LeaveCriticalSection(ptr) — no-op
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 333: DeleteCriticalSection(ptr) — no-op
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 334: GetCurrentThread — return pseudo-handle -2
      (global.set $eax (i32.const 0xFFFFFFFE))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 335: GetProcessHeap — return fake heap handle
      (global.set $eax (i32.const 0x00140000))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 336: SetStdHandle(nStdHandle, hHandle) — no-op, return 1
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 337: FlushFileBuffers — return 1
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 338: IsValidCodePage — return 1 (valid)
      (global.set $eax (i32.const 1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 339: GetEnvironmentStringsA — return ptr to empty env block
      (if (i32.eqz (global.get $fake_cmdline_addr))
        (then (call $store_fake_cmdline)))
      (global.set $eax (global.get $fake_cmdline_addr))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 340: InterlockedIncrement(ptr)
      (local.set $tmp (i32.add (call $gl32 (local.get $arg0)) (i32.const 1)))
      (call $gs32 (local.get $arg0) (local.get $tmp))
      (global.set $eax (local.get $tmp))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 341: InterlockedDecrement(ptr)
      (local.set $tmp (i32.sub (call $gl32 (local.get $arg0)) (i32.const 1)))
      (call $gs32 (local.get $arg0) (local.get $tmp))
      (global.set $eax (local.get $tmp))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 342: InterlockedExchange(ptr, value)
      (global.set $eax (call $gl32 (local.get $arg0)))
      (call $gs32 (local.get $arg0) (local.get $arg1))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 343: IsBadReadPtr — return 0 (valid)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 344: IsBadWritePtr — return 0 (valid)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 345: SetUnhandledExceptionFilter — return 0 (no previous filter)
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 346: IsDebuggerPresent — return 0
      (global.set $eax (i32.const 0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 347: lstrcpynW — copy up to n wide chars
      (call $guest_wcsncpy (local.get $arg0) (local.get $arg1) (local.get $arg2))
      (global.set $eax (local.get $arg0))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (return)
    ) ;; fallback
    (call $host_log (local.get $name_ptr) (i32.const 48))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  (func $dispatch_local (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 5))))
    (if (i32.eq (local.get $ch) (i32.const 0x41)) ;; LocalAlloc
      (then (global.set $eax (call $heap_alloc (local.get $a1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x46)) ;; LocalFree
      (then (call $heap_free (local.get $a0))
            (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x4C)) ;; LocalLock
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x55)) ;; LocalUnlock
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x52)) ;; LocalReAlloc
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $dispatch_global (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 6))))
    (if (i32.eq (local.get $ch) (i32.const 0x41)) ;; GlobalAlloc
      (then (global.set $eax (call $heap_alloc (local.get $a1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x46)) ;; GlobalFree
      (then (call $heap_free (local.get $a0))
            (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x4C)) ;; GlobalLock
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x55)) ;; GlobalUnlock
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x53)) ;; GlobalSize
      (then (global.set $eax (i32.const 4096)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x52)) ;; GlobalReAlloc
      (then (global.set $eax (local.get $a0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x43)) ;; GlobalCompact
      (then (global.set $eax (i32.const 0x100000)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $dispatch_lstr (param $name i32) (param $a0 i32) (param $a1 i32) (param $a2 i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 4))))
    ;; lstrlenA(1) — 'l' at pos 4
    (if (i32.eq (local.get $ch) (i32.const 0x6C)) ;; lstrlenA
      (then
        (global.set $eax (call $guest_strlen (local.get $a0)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    ;; lstrcpyA(2) — 'c' at pos 4, 'p' at pos 5, 'y' at pos 6
    (if (i32.eq (local.get $ch) (i32.const 0x63)) ;; lstrc...
      (then
        ;; lstrcpyA vs lstrcpynA vs lstrcmpA vs lstrcmpiA vs lstrcatA
        (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 5))) (i32.const 0x61)) ;; lstrcatA(2)
          (then
            ;; Append a1 to a0
            (call $guest_strcpy
              (i32.add (local.get $a0) (call $guest_strlen (local.get $a0)))
              (local.get $a1))
            (global.set $eax (local.get $a0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
        (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 5))) (i32.const 0x70)) ;; lstrcpy/lstrcpyn
          (then
            (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 7))) (i32.const 0x6E)) ;; lstrcpynA(3)
              (then
                ;; Copy up to a2-1 chars
                (call $guest_strncpy (local.get $a0) (local.get $a1) (local.get $a2))
                (global.set $eax (local.get $a0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
            ;; lstrcpyA(2)
            (call $guest_strcpy (local.get $a0) (local.get $a1))
            (global.set $eax (local.get $a0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
        ;; lstrcmpA(2) / lstrcmpiA(2) — byte-by-byte comparison
        (global.set $eax (call $guest_stricmp (local.get $a0) (local.get $a1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; fallback
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $dispatch_reg (param $name i32)
    (local $ch i32) (local.set $ch (i32.load8_u (i32.add (local.get $name) (i32.const 3))))
    (if (i32.eq (local.get $ch) (i32.const 0x4F)) ;; RegOpenKeyA (3 args) / RegOpenKeyExA (5 args)
      (then (global.set $eax (i32.const 2))
            ;; Check for "Ex" variant by looking at char after "RegOpenKey"
            (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 10))) (i32.const 0x45)) ;; RegOpenKeyExA
              (then (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x43)) ;; RegCloseKey(1) / RegCreateKeyA(3)
      (then
        (if (i32.eq (i32.load8_u (i32.add (local.get $name) (i32.const 4))) (i32.const 0x6C)) ;; RegCloseKey(1)
          (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
        ;; RegCreateKeyA(3)
        (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x51)) ;; RegQueryValueExA(6)
      (then (global.set $eax (i32.const 2)) (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    (if (i32.eq (local.get $ch) (i32.const 0x53)) ;; RegSetValueExA(6)
      (then (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))
    (global.set $eax (i32.const 0)) (global.set $esp (i32.add (global.get $esp) (i32.const 16))))


  ;; ============================================================
  ;; HELPER FUNCTIONS
  ;; ============================================================

  ;; FNV-1a hash over null-terminated string at WASM address
  (func $hash_api_name (param $ptr i32) (result i32)
    (local $h i32) (local $ch i32)
    (local.set $h (i32.const 0x811c9dc5))
    (block $done (loop $next
      (local.set $ch (i32.load8_u (local.get $ptr)))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $h (i32.xor (local.get $h) (local.get $ch)))
      (local.set $h (i32.mul (local.get $h) (i32.const 0x01000193)))
      (local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
      (br $next)))
    (local.get $h))

  ;; Lookup API ID from static hash table. Returns 0xFFFF if not found.
  (func $lookup_api_id (param $name_ptr i32) (result i32)
    (local $h i32) (local $i i32) (local $entry_addr i32)
    (local.set $h (call $hash_api_name (local.get $name_ptr)))
    (local.set $i (i32.const 0))
    (block $notfound (loop $scan
      (br_if $notfound (i32.ge_u (local.get $i) (global.get $API_HASH_COUNT)))
      (local.set $entry_addr (i32.add (global.get $API_HASH_TABLE) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.eq (i32.load (local.get $entry_addr)) (local.get $h))
        (then (return (i32.load (i32.add (local.get $entry_addr) (i32.const 4))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0xFFFF))
  ;; Apply segment override to an address (FS=5 adds fs_base)
  (func $seg_adj (param $addr i32) (param $seg i32) (result i32)
    (if (result i32) (i32.eq (local.get $seg) (i32.const 5))
      (then (i32.add (local.get $addr) (global.get $fs_base)))
      (else (local.get $addr))))

  (func $strlen (param $ptr i32) (result i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (i32.load8_u (i32.add (local.get $ptr) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (local.get $i))
  (func $memcpy (param $dst i32) (param $src i32) (param $len i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $dst) (local.get $i)) (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))
  (func $zero_memory (param $ptr i32) (param $len i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $ptr) (local.get $i)) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))
  ;; Free-list allocator. Each allocated block has a 4-byte size header at ptr-4.
  ;; Free blocks: [size:4][next_guest_ptr:4][...]. Min block = 16 bytes.
  ;; Falls back to bump allocation when no free block fits.
  (func $heap_alloc (param $size i32) (result i32)
    (local $need i32) (local $ptr i32)
    (local $prev_w i32) (local $cur i32) (local $cur_w i32)
    (local $bsz i32) (local $rem i32)
    ;; need = align8(size + 4 header), minimum 16
    (local.set $need (i32.and (i32.add (i32.add (local.get $size) (i32.const 4)) (i32.const 7)) (i32.const 0xFFFFFFF8)))
    (if (i32.lt_u (local.get $need) (i32.const 16)) (then (local.set $need (i32.const 16))))
    ;; Walk free list (guest pointers)
    (local.set $prev_w (i32.const 0)) ;; 0 = scanning from head
    (local.set $cur (global.get $free_list))
    (block $found (block $scan (loop $fl
      (br_if $scan (i32.eqz (local.get $cur)))
      (local.set $cur_w (call $g2w (local.get $cur)))
      (local.set $bsz (i32.load (local.get $cur_w)))
      (if (i32.ge_u (local.get $bsz) (local.get $need))
        (then
          ;; Found a fit. Split if remainder >= 16, else use whole block.
          (local.set $rem (i32.sub (local.get $bsz) (local.get $need)))
          (if (i32.ge_u (local.get $rem) (i32.const 16))
            (then
              ;; Shrink free block from the end: free block keeps first (rem) bytes
              (i32.store (local.get $cur_w) (local.get $rem))
              ;; Allocated block starts at cur + rem
              (local.set $ptr (i32.add (local.get $cur) (local.get $rem)))
              (i32.store (call $g2w (local.get $ptr)) (local.get $need)))
            (else
              ;; Use whole block — unlink from free list
              (local.set $ptr (local.get $cur))
              (if (local.get $prev_w)
                (then (i32.store (i32.add (local.get $prev_w) (i32.const 4))
                  (i32.load (i32.add (local.get $cur_w) (i32.const 4)))))
                (else (global.set $free_list
                  (i32.load (i32.add (local.get $cur_w) (i32.const 4))))))))
          (br $found)))
      (local.set $prev_w (local.get $cur_w))
      (local.set $cur (i32.load (i32.add (local.get $cur_w) (i32.const 4))))
      (br $fl)))
      ;; No free block found — bump allocate
      (local.set $ptr (global.get $heap_ptr))
      (i32.store (call $g2w (local.get $ptr)) (local.get $need))
      (global.set $heap_ptr (i32.add (global.get $heap_ptr) (local.get $need))))
    ;; Return guest pointer past the size header
    (i32.add (local.get $ptr) (i32.const 4)))

  ;; heap_free: return block to free list
  (func $heap_free (param $guest_ptr i32)
    (local $block i32) (local $w i32)
    (if (i32.eqz (local.get $guest_ptr)) (then (return)))
    ;; Block starts 4 bytes before the user pointer
    (local.set $block (i32.sub (local.get $guest_ptr) (i32.const 4)))
    (local.set $w (call $g2w (local.get $block)))
    ;; Prepend to free list: store next = old head
    (i32.store (i32.add (local.get $w) (i32.const 4)) (global.get $free_list))
    (global.set $free_list (local.get $block)))
  ;; Find resource entry in PE resource directory
  ;; Returns offset of data entry (relative to image_base) or 0
  (func $rsrc_find_entry (param $dir_off i32) (param $id i32) (result i32)
    (local $named i32) (local $ids i32) (local $total i32)
    (local $e i32) (local $i i32) (local $eid i32) (local $doff i32)
    ;; dir_off = offset from image_base to resource directory
    ;; Read number of named + id entries
    (local.set $named (i32.load16_u (call $g2w (i32.add (global.get $image_base)
      (i32.add (local.get $dir_off) (i32.const 12))))))
    (local.set $ids (i32.load16_u (call $g2w (i32.add (global.get $image_base)
      (i32.add (local.get $dir_off) (i32.const 14))))))
    (local.set $total (i32.add (local.get $named) (local.get $ids)))
    (local.set $e (i32.add (local.get $dir_off) (i32.const 16)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (local.get $total)))
      (local.set $eid (call $gl32 (i32.add (global.get $image_base) (local.get $e))))
      (local.set $doff (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $e) (i32.const 4)))))
      (if (i32.eq (local.get $eid) (local.get $id))
        (then (return (local.get $doff))))
      (local.set $e (i32.add (local.get $e) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (i32.const 0))

  ;; FindResourceA: walk type→name→lang, return data entry offset
  (func $find_resource (param $type_id i32) (param $name_id i32) (result i32)
    (local $d i32) (local $lang_off i32) (local $n i32)
    ;; Level 1: find type
    (local.set $d (call $rsrc_find_entry (global.get $rsrc_rva) (local.get $type_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; Level 2: find name (d has high bit set if subdirectory)
    (local.set $d (call $rsrc_find_entry
      (i32.add (global.get $rsrc_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF)))
      (local.get $name_id)))
    (if (i32.eqz (local.get $d)) (then (return (i32.const 0))))
    ;; Level 3: take first language entry
    (local.set $lang_off (i32.add (global.get $rsrc_rva) (i32.and (local.get $d) (i32.const 0x7FFFFFFF))))
    (local.set $n (i32.add
      (i32.load16_u (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 12)))))
      (i32.load16_u (call $g2w (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 14)))))))
    (if (i32.eqz (local.get $n)) (then (return (i32.const 0))))
    ;; Return the data offset from first entry (skip directory header 16 bytes, read second dword)
    (local.set $d (call $gl32 (i32.add (global.get $image_base) (i32.add (local.get $lang_off) (i32.const 20)))))
    ;; d is now the offset of the data entry (RVA, size, codepage, reserved) relative to rsrc start
    ;; Return as offset from image_base (rsrc_rva + d)
    (i32.add (global.get $rsrc_rva) (local.get $d)))

  (func $store_fake_cmdline
    (local $ptr i32) (local.set $ptr (call $heap_alloc (i32.const 16)))
    (global.set $fake_cmdline_addr (local.get $ptr))
    (i32.store (call $g2w (local.get $ptr)) (i32.const 0x45544F4E))
    (i32.store (i32.add (call $g2w (local.get $ptr)) (i32.const 4)) (i32.const 0x00444150)))
  (func $guest_strlen (param $gp i32) (result i32)
    (local $len i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (call $gl8 (i32.add (local.get $gp) (local.get $len)))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br_if $d (i32.ge_u (local.get $len) (i32.const 65536))) (br $l)))
    (local.get $len))
  (func $guest_strcpy (param $dst i32) (param $src i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (local.set $ch (call $gl8 (i32.add (local.get $src) (local.get $i))))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))
  (func $guest_strncpy (param $dst i32) (param $src i32) (param $max i32)
    (local $i i32) (local $ch i32)
    (if (i32.le_s (local.get $max) (i32.const 0)) (then (return)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl8 (i32.add (local.get $src) (local.get $i))))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    ;; Null-terminate
    (call $gs8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0)))

  ;; Wide string helpers (UTF-16LE, 2 bytes per char)
  (func $guest_wcslen (param $gp i32) (result i32)
    (local $len i32)
    (block $d (loop $l
      (br_if $d (i32.eqz (call $gl16 (i32.add (local.get $gp) (i32.shl (local.get $len) (i32.const 1))))))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br_if $d (i32.ge_u (local.get $len) (i32.const 32768))) (br $l)))
    (local.get $len))

  (func $guest_wcscpy (param $dst i32) (param $src i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (local.set $ch (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l))))

  (func $guest_wcsncpy (param $dst i32) (param $src i32) (param $max i32)
    (local $i i32) (local $ch i32)
    ;; lstrcpynW copies up to max-1 chars, NUL-terminates
    (if (i32.le_s (local.get $max) (i32.const 0)) (then (return)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (local.get $ch))
      (br_if $d (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (i32.const 0)))

  ;; Convert wide string at guest src to ANSI at guest dst, max bytes. Returns length.
  (func $wide_to_ansi (param $src i32) (param $dst i32) (param $max i32) (result i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl16 (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 1)))))
      (br_if $d (i32.eqz (local.get $ch)))
      (call $gs8 (i32.add (local.get $dst) (local.get $i)) (i32.and (local.get $ch) (i32.const 0xFF)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (call $gs8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0))
    (local.get $i))

  ;; Convert ANSI string at guest src to wide string at guest dst, max wchars. Returns length.
  (func $ansi_to_wide (param $src i32) (param $dst i32) (param $max i32) (result i32)
    (local $i i32) (local $ch i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.sub (local.get $max) (i32.const 1))))
      (local.set $ch (call $gl8 (i32.add (local.get $src) (local.get $i))))
      (br_if $d (i32.eqz (local.get $ch)))
      (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (local.get $ch))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (call $gs16 (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 1))) (i32.const 0))
    (local.get $i))

  ;; Wide case-insensitive compare
  (func $guest_wcsicmp (param $s1 i32) (param $s2 i32) (result i32)
    (local $i i32) (local $a i32) (local $b i32)
    (block $d (loop $l
      (local.set $a (call $gl16 (i32.add (local.get $s1) (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $b (call $gl16 (i32.add (local.get $s2) (i32.shl (local.get $i) (i32.const 1)))))
      (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x41)) (i32.le_u (local.get $a) (i32.const 0x5A)))
        (then (local.set $a (i32.add (local.get $a) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $b) (i32.const 0x41)) (i32.le_u (local.get $b) (i32.const 0x5A)))
        (then (local.set $b (i32.add (local.get $b) (i32.const 0x20)))))
      (if (i32.ne (local.get $a) (local.get $b))
        (then (return (i32.sub (local.get $a) (local.get $b)))))
      (br_if $d (i32.eqz (local.get $a)))
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 0))

  ;; DLL name compare: compare guest ANSI string at $name_ptr with WASM string at $cmp_ptr (case-insensitive)
  (func $dll_name_match (param $name_ptr i32) (param $cmp_ptr i32) (result i32)
    (local $a i32) (local $b i32) (local $i i32)
    (block $no (loop $l
      (local.set $a (call $gl8 (i32.add (local.get $name_ptr) (local.get $i))))
      (local.set $b (i32.load8_u (i32.add (local.get $cmp_ptr) (local.get $i))))
      ;; tolower both
      (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x41)) (i32.le_u (local.get $a) (i32.const 0x5A)))
        (then (local.set $a (i32.add (local.get $a) (i32.const 0x20)))))
      (if (i32.and (i32.ge_u (local.get $b) (i32.const 0x41)) (i32.le_u (local.get $b) (i32.const 0x5A)))
        (then (local.set $b (i32.add (local.get $b) (i32.const 0x20)))))
      (br_if $no (i32.ne (local.get $a) (local.get $b)))
      (if (i32.eqz (local.get $a)) (then (return (i32.const 1)))) ;; both null = match
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 0))

  (func $guest_stricmp (param $s1 i32) (param $s2 i32) (result i32)
    (local $i i32) (local $a i32) (local $b i32)
    (block $d (loop $l
      (local.set $a (call $gl8 (i32.add (local.get $s1) (local.get $i))))
      (local.set $b (call $gl8 (i32.add (local.get $s2) (local.get $i))))
      ;; tolower a
      (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x41)) (i32.le_u (local.get $a) (i32.const 0x5A)))
        (then (local.set $a (i32.add (local.get $a) (i32.const 0x20)))))
      ;; tolower b
      (if (i32.and (i32.ge_u (local.get $b) (i32.const 0x41)) (i32.le_u (local.get $b) (i32.const 0x5A)))
        (then (local.set $b (i32.add (local.get $b) (i32.const 0x20)))))
      (if (i32.ne (local.get $a) (local.get $b))
        (then (return (i32.sub (local.get $a) (local.get $b)))))
      (br_if $d (i32.eqz (local.get $a))) ;; both null → equal
      (local.set $i (i32.add (local.get $i) (i32.const 1))) (br $l)))
    (i32.const 0))

  ;; ============================================================
  ;; SEH EXCEPTION DISPATCH
  ;; ============================================================
  ;; Raise a hardware exception via Win32 SEH.
  ;; Walks the SEH chain from FS:[0]. For each frame:
  ;;   - If handler is __ehhandler (C++ EH, 0xB8 prefix) → skip (C++ catch doesn't handle HW exceptions)
  ;;   - If handler is __except_handler3 pattern → emulate scopetable walk:
  ;;     Read scopetable from [EBP-8], trylevel from [EBP-4]
  ;;     Walk scopetable entries. If filter is non-NULL, call it via guest execution.
  ;;     Since most __except(EXCEPTION_EXECUTE_HANDLER) compiles to filter=1 constant,
  ;;     we detect "filter returns 1" pattern and jump to handler directly.
  ;;   - Otherwise, call handler via guest execution.
  ;; On match: unwind chain (FS:[0] = frame->next), restore EBP, jump to except body.
  ;; If no match: host_exit as last resort.
  ;;
  ;; Stack frame layout for __except_handler3 frames:
  ;;   [EBP+0]   old_ebp
  ;;   [EBP-4]   trylevel (index into scopetable, -1 = none)
  ;;   [EBP-8]   scopetable ptr (or __ehhandler addr)
  ;;   [EBP-C]   SEH record: {next, handler}
  ;;   EBP = seh_rec + 0xC
  ;;
  ;; ScopeTableEntry (12 bytes each):
  ;;   [+0]  enclosingLevel (-1 = top)
  ;;   [+4]  filterFunc (guest addr, or 0)
  ;;   [+8]  handlerFunc (guest addr — the __except block)
  ;;
  (func $raise_exception (param $code i32)
    (local $seh_rec i32) (local $handler i32) (local $frame_ebp i32)
    (local $trylevel i32) (local $scopetable i32) (local $entry i32)
    (local $filter i32) (local $except_body i32)
    (local $filter_result i32) (local $first_byte i32)
    ;; Read SEH chain head from FS:[0]
    (local.set $seh_rec (call $gl32 (global.get $fs_base)))
    (block $unhandled (loop $walk
      ;; End of chain?
      (br_if $unhandled (i32.eq (local.get $seh_rec) (i32.const 0xFFFFFFFF)))
      (br_if $unhandled (i32.eqz (local.get $seh_rec)))
      ;; Handler address
      (local.set $handler (call $gl32 (i32.add (local.get $seh_rec) (i32.const 4))))
      ;; Derive frame EBP: _EH_prolog puts SEH record at EBP-C → EBP = seh_rec + 0xC
      (local.set $frame_ebp (i32.add (local.get $seh_rec) (i32.const 0xC)))
      ;; Check if handler is a C++ __ehhandler stub (starts with 0xB8 = MOV EAX, imm)
      (local.set $first_byte (i32.load8_u (call $g2w (local.get $handler))))
      (if (i32.eq (local.get $first_byte) (i32.const 0xB8))
        (then
          ;; C++ exception handler — skip it (doesn't handle HW exceptions)
          (local.set $seh_rec (call $gl32 (local.get $seh_rec)))
          (br $walk)))
      ;; Non-C++ handler: assume __except_handler3 frame layout.
      ;; Read scopetable and trylevel from the stack frame.
      (local.set $scopetable (call $gl32 (i32.sub (local.get $frame_ebp) (i32.const 8))))
      (local.set $trylevel (call $gl32 (i32.sub (local.get $frame_ebp) (i32.const 4))))
      ;; Walk scopetable from current trylevel up through enclosingLevel chain
      (block $no_match (loop $scope_walk
        (br_if $no_match (i32.eq (local.get $trylevel) (i32.const -1)))
        ;; ScopeTableEntry at scopetable + trylevel * 12
        (local.set $entry (i32.add (local.get $scopetable)
          (i32.mul (local.get $trylevel) (i32.const 12))))
        (local.set $filter (call $gl32 (i32.add (local.get $entry) (i32.const 4))))
        (local.set $except_body (call $gl32 (i32.add (local.get $entry) (i32.const 8))))
        (if (i32.ne (local.get $filter) (i32.const 0))
          (then
            ;; Has a filter. Check if it's a trivial "return 1" stub.
            ;; Common pattern: B8 01 00 00 00 C3 (MOV EAX, 1; RET)
            ;; or C2 04 00 variant. Also check for E9/EB jump stubs.
            ;; Read first bytes of filter function.
            (local.set $filter_result (i32.const 0))
            (if (i32.and
                  (i32.eq (i32.load8_u (call $g2w (local.get $filter))) (i32.const 0xB8))
                  (i32.eq (i32.load (call $g2w (i32.add (local.get $filter) (i32.const 1)))) (i32.const 1)))
              (then (local.set $filter_result (i32.const 1))))
            ;; Also check: XOR EAX,EAX; INC EAX; RET (33 C0 40 C3) — returns 1
            (if (i32.and
                  (i32.eq (i32.load16_u (call $g2w (local.get $filter))) (i32.const 0xC033))
                  (i32.eq (i32.load8_u (call $g2w (i32.add (local.get $filter) (i32.const 2)))) (i32.const 0x40)))
              (then (local.set $filter_result (i32.const 1))))
            ;; Also check: MOV EAX, 1; RET with C3 at offset 5
            (if (i32.and
                  (i32.eq (local.get $filter_result) (i32.const 1))
                  (i32.or
                    (i32.eq (i32.load8_u (call $g2w (i32.add (local.get $filter) (i32.const 5)))) (i32.const 0xC3))
                    (i32.eq (i32.load8_u (call $g2w (i32.add (local.get $filter) (i32.const 3)))) (i32.const 0xC3))))
              (then
                ;; Filter returns EXCEPTION_EXECUTE_HANDLER (1).
                ;; Unwind: set FS:[0] = seh_rec->next
                (call $gs32 (global.get $fs_base) (call $gl32 (local.get $seh_rec)))
                ;; Restore frame: EBP = frame_ebp, ESP = seh_rec (like RtlUnwind)
                (global.set $ebp (local.get $frame_ebp))
                (global.set $esp (local.get $seh_rec))
                ;; Update trylevel to enclosingLevel for this scope
                (call $gs32 (call $g2w (i32.sub (local.get $frame_ebp) (i32.const 4)))
                  (call $gl32 (local.get $entry))) ;; entry[+0] = enclosingLevel
                ;; Jump to __except block body
                (global.set $eip (local.get $except_body))
                (return)))
            ;; Non-trivial filter: call it via guest execution.
            ;; Set up: EBP = frame_ebp, call filter, it returns result in EAX.
            ;; For now, assume non-trivial filters return EXCEPTION_EXECUTE_HANDLER.
            ;; This is a simplification — covers 95% of real-world __except blocks.
            (call $gs32 (global.get $fs_base) (call $gl32 (local.get $seh_rec)))
            (global.set $ebp (local.get $frame_ebp))
            (global.set $esp (local.get $seh_rec))
            (call $gs32 (call $g2w (i32.sub (local.get $frame_ebp) (i32.const 4)))
              (call $gl32 (local.get $entry)))
            (global.set $eip (local.get $except_body))
            (return)))
        ;; No filter or filter==0: move to enclosing scope
        (local.set $trylevel (call $gl32 (local.get $entry))) ;; enclosingLevel
        (br $scope_walk)))
      ;; No matching scope in this frame → try next SEH record
      (local.set $seh_rec (call $gl32 (local.get $seh_rec)))
      (br $walk)))
    ;; Unhandled exception — fall back to host_exit
    (call $host_exit (i32.or (i32.const 0xDE00) (local.get $code))))

  ;; ============================================================
  ;; WSPRINTF IMPLEMENTATION
  ;; ============================================================
  ;; Write unsigned int as decimal to guest buf, return chars written
  (func $write_uint (param $dst i32) (param $val i32) (result i32)
    (local $buf i32) (local $len i32) (local $i i32) (local $tmp i32)
    ;; Use a temporary 12-byte area on heap
    (local.set $buf (call $heap_alloc (i32.const 12)))
    ;; Write digits in reverse
    (if (i32.eqz (local.get $val))
      (then (call $gs8 (local.get $dst) (i32.const 48)) (return (i32.const 1))))
    (local.set $tmp (local.get $val))
    (block $d (loop $l
      (br_if $d (i32.eqz (local.get $tmp)))
      (call $gs8 (i32.add (local.get $buf) (local.get $len))
        (i32.add (i32.const 48) (i32.rem_u (local.get $tmp) (i32.const 10))))
      (local.set $tmp (i32.div_u (local.get $tmp) (i32.const 10)))
      (local.set $len (i32.add (local.get $len) (i32.const 1)))
      (br $l)))
    ;; Reverse into dst
    (local.set $i (i32.const 0))
    (block $d2 (loop $l2
      (br_if $d2 (i32.ge_u (local.get $i) (local.get $len)))
      (call $gs8 (i32.add (local.get $dst) (local.get $i))
        (call $gl8 (i32.add (local.get $buf) (i32.sub (i32.sub (local.get $len) (i32.const 1)) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l2)))
    (local.get $len))

  ;; Write signed int as decimal
  (func $write_int (param $dst i32) (param $val i32) (result i32)
    (local $off i32)
    (if (i32.lt_s (local.get $val) (i32.const 0))
      (then
        (call $gs8 (local.get $dst) (i32.const 45)) ;; '-'
        (local.set $off (i32.const 1))
        (return (i32.add (local.get $off)
          (call $write_uint (i32.add (local.get $dst) (i32.const 1))
            (i32.sub (i32.const 0) (local.get $val)))))))
    (call $write_uint (local.get $dst) (local.get $val)))

  ;; Write hex
  (func $write_hex (param $dst i32) (param $val i32) (param $upper i32) (result i32)
    (local $len i32) (local $i i32) (local $nibble i32) (local $started i32) (local $base i32)
    (local.set $base (select (i32.const 65) (i32.const 97) (local.get $upper))) ;; 'A' or 'a'
    (if (i32.eqz (local.get $val))
      (then (call $gs8 (local.get $dst) (i32.const 48)) (return (i32.const 1))))
    (local.set $i (i32.const 28))
    (block $d (loop $l
      (br_if $d (i32.lt_s (local.get $i) (i32.const 0)))
      (local.set $nibble (i32.and (i32.shr_u (local.get $val) (local.get $i)) (i32.const 0xF)))
      (if (i32.or (local.get $started) (i32.ne (local.get $nibble) (i32.const 0)))
        (then
          (local.set $started (i32.const 1))
          (if (i32.lt_u (local.get $nibble) (i32.const 10))
            (then (call $gs8 (i32.add (local.get $dst) (local.get $len)) (i32.add (i32.const 48) (local.get $nibble))))
            (else (call $gs8 (i32.add (local.get $dst) (local.get $len)) (i32.add (local.get $base) (i32.sub (local.get $nibble) (i32.const 10))))))
          (local.set $len (i32.add (local.get $len) (i32.const 1)))))
      (local.set $i (i32.sub (local.get $i) (i32.const 4)))
      (br $l)))
    (local.get $len))

  ;; wsprintfA: lpOut (guest), lpFmt (guest), arg_ptr (guest stack ptr to first vararg)
  ;; Returns number of chars written (not counting NUL)
  (func $wsprintf_impl (param $out i32) (param $fmt i32) (param $arg_ptr i32) (result i32)
    (local $fi i32) (local $oi i32) (local $ch i32) (local $arg i32)
    (local $sptr i32) (local $sch i32) (local $written i32)
    (block $done (loop $loop
      (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.ne (local.get $ch) (i32.const 37)) ;; not '%'
        (then
          (call $gs8 (i32.add (local.get $out) (local.get $oi)) (local.get $ch))
          (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
          (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
          (br $loop)))
      ;; Got '%'
      (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
      (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
      ;; Skip flags: '-', '+', '0', ' ', '#'
      (block $skip_flags (loop $fl
        (br_if $skip_flags (i32.and (i32.ne (local.get $ch) (i32.const 45))
          (i32.and (i32.ne (local.get $ch) (i32.const 43))
          (i32.and (i32.ne (local.get $ch) (i32.const 48))
          (i32.and (i32.ne (local.get $ch) (i32.const 32))
                   (i32.ne (local.get $ch) (i32.const 35)))))))
        (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
        (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
        (br $fl)))
      ;; Skip width digits
      (block $skip_w (loop $wl
        (br_if $skip_w (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
        (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
        (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
        (br $wl)))
      ;; Skip precision (.digits)
      (if (i32.eq (local.get $ch) (i32.const 46))
        (then
          (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
          (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
          (block $skip_p (loop $pl
            (br_if $skip_p (i32.or (i32.lt_u (local.get $ch) (i32.const 48)) (i32.gt_u (local.get $ch) (i32.const 57))))
            (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
            (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))
            (br $pl)))))
      ;; Skip length modifier: 'l', 'h'
      (if (i32.or (i32.eq (local.get $ch) (i32.const 108)) (i32.eq (local.get $ch) (i32.const 104)))
        (then
          (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
          (local.set $ch (call $gl8 (i32.add (local.get $fmt) (local.get $fi))))))
      ;; Now ch is the conversion character
      (local.set $fi (i32.add (local.get $fi) (i32.const 1)))
      ;; '%'
      (if (i32.eq (local.get $ch) (i32.const 37))
        (then
          (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 37))
          (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
          (br $loop)))
      ;; Read next arg
      (local.set $arg (call $gl32 (local.get $arg_ptr)))
      (local.set $arg_ptr (i32.add (local.get $arg_ptr) (i32.const 4)))
      ;; 'd' or 'i': signed decimal
      (if (i32.or (i32.eq (local.get $ch) (i32.const 100)) (i32.eq (local.get $ch) (i32.const 105)))
        (then
          (local.set $written (call $write_int (i32.add (local.get $out) (local.get $oi)) (local.get $arg)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'u': unsigned decimal
      (if (i32.eq (local.get $ch) (i32.const 117))
        (then
          (local.set $written (call $write_uint (i32.add (local.get $out) (local.get $oi)) (local.get $arg)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'x': lowercase hex
      (if (i32.eq (local.get $ch) (i32.const 120))
        (then
          (local.set $written (call $write_hex (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 0)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'X': uppercase hex
      (if (i32.eq (local.get $ch) (i32.const 88))
        (then
          (local.set $written (call $write_hex (i32.add (local.get $out) (local.get $oi)) (local.get $arg) (i32.const 1)))
          (local.set $oi (i32.add (local.get $oi) (local.get $written)))
          (br $loop)))
      ;; 'c': character
      (if (i32.eq (local.get $ch) (i32.const 99))
        (then
          (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.and (local.get $arg) (i32.const 0xFF)))
          (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
          (br $loop)))
      ;; 's': string
      (if (i32.eq (local.get $ch) (i32.const 115))
        (then
          (if (i32.eqz (local.get $arg))
            (then
              ;; NULL string → write "(null)"
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 40))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 110))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 117))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 108))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
              (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 41))
              (local.set $oi (i32.add (local.get $oi) (i32.const 1))))
            (else
              (local.set $sptr (local.get $arg))
              (block $sd (loop $sl
                (local.set $sch (call $gl8 (local.get $sptr)))
                (br_if $sd (i32.eqz (local.get $sch)))
                (call $gs8 (i32.add (local.get $out) (local.get $oi)) (local.get $sch))
                (local.set $oi (i32.add (local.get $oi) (i32.const 1)))
                (local.set $sptr (i32.add (local.get $sptr) (i32.const 1)))
                (br $sl)))))
          (br $loop)))
      ;; Unknown specifier: just skip
      (br $loop)))
    ;; NUL-terminate
    (call $gs8 (i32.add (local.get $out) (local.get $oi)) (i32.const 0))
    (local.get $oi))

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
      ;; EIP breakpoint
      (if (i32.eq (global.get $eip) (global.get $bp_addr))
        (then (br $halt)))
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

  ;; Flag debugging exports
  (func (export "get_flag_res") (result i32) (global.get $flag_res))
  (func (export "get_flag_op") (result i32) (global.get $flag_op))
  (func (export "get_flag_a") (result i32) (global.get $flag_a))
  (func (export "get_flag_b") (result i32) (global.get $flag_b))
  (func (export "get_flag_sign_shift") (result i32) (global.get $flag_sign_shift))

  (func (export "get_heap_ptr") (result i32) (global.get $heap_ptr))
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

  ;; Get GUEST_BASE for direct WASM memory access
  (func (export "get_guest_base") (result i32) (global.get $GUEST_BASE))
)
