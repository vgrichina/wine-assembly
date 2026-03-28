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
  ;; 0x00E62000  ...     Free

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
  ;; Guest-space address of catch-return thunk (set during PE load)
  (global $catch_ret_thunk (mut i32) (i32.const 0))
  ;; FS segment base — points to fake TIB (allocated from heap during PE load)
  (global $fs_base (mut i32) (i32.const 0))
  ;; Current segment prefix during decoding (set before decode_modrm)
  (global $d_seg (mut i32) (i32.const 0))

  ;; Runtime EA temp for SIB addressing
  (global $ea_temp (mut i32) (i32.const 0))

  ;; Window system state
  (global $wndproc_addr (mut i32) (i32.const 0))    ;; WndProc function pointer (guest VA)
  (global $main_hwnd    (mut i32) (i32.const 0))    ;; Main window handle
  (global $next_hwnd    (mut i32) (i32.const 0x10001)) ;; HWND allocator
  (global $pending_wm_create (mut i32) (i32.const 0)) ;; deliver WM_CREATE as next GetMessageA
  (global $msg_phase    (mut i32) (i32.const 0))    ;; Message loop phase
  (global $quit_flag    (mut i32) (i32.const 0))    ;; Set by PostQuitMessage
  (global $yield_flag   (mut i32) (i32.const 0))    ;; Set by GetMessageA when no input; cleared by run()
  (global $last_error   (mut i32) (i32.const 0))    ;; GetLastError value
  (global $haccel       (mut i32) (i32.const 0))    ;; Accelerator table handle
  (global $dlg_hwnd     (mut i32) (i32.const 0))    ;; Dialog window handle

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
  (table $handlers 159 funcref)

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
    (global.set $flag_op (i32.const 1))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b)) (global.set $flag_res (local.get $r)))
  (func $set_flags_sub (param $a i32) (param $b i32) (param $r i32)
    (global.set $flag_op (i32.const 2))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (local.get $b)) (global.set $flag_res (local.get $r)))
  (func $set_flags_logic (param $r i32)
    (global.set $flag_op (i32.const 3)) (global.set $flag_res (local.get $r)))
  (func $set_flags_shift (param $r i32) (param $cf i32)
    (global.set $flag_op (i32.const 7)) (global.set $flag_res (local.get $r))
    (global.set $saved_cf (local.get $cf)))
  (func $set_flags_inc (param $a i32) (param $r i32)
    (global.set $saved_cf (call $get_cf))  ;; INC preserves CF
    (global.set $flag_op (i32.const 4))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (i32.const 1)) (global.set $flag_res (local.get $r)))
  (func $set_flags_dec (param $a i32) (param $r i32)
    (global.set $saved_cf (call $get_cf))  ;; DEC preserves CF
    (global.set $flag_op (i32.const 5))
    (global.set $flag_a (local.get $a)) (global.set $flag_b (i32.const 1)) (global.set $flag_res (local.get $r)))

  (func $get_zf (result i32) (i32.eqz (global.get $flag_res)))
  (func $get_sf (result i32) (i32.shr_u (global.get $flag_res) (i32.const 31)))
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
    (else (i32.const 0))))))))))))
  (func $get_of (result i32)
    (local $sa i32) (local $sb i32) (local $sr i32)
    ;; MUL/IMUL: OF = CF = flag_b
    (if (i32.eq (global.get $flag_op) (i32.const 6))
      (then (return (global.get $flag_b))))
    (local.set $sa (i32.shr_u (global.get $flag_a) (i32.const 31)))
    (local.set $sb (i32.shr_u (global.get $flag_b) (i32.const 31)))
    (local.set $sr (i32.shr_u (global.get $flag_res) (i32.const 31)))
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

  ;; Restore flags from EFLAGS value (for popfd) - approximate
  (func $load_eflags (param $f i32)
    (global.set $df (i32.and (i32.shr_u (local.get $f) (i32.const 10)) (i32.const 1)))
    ;; Set flag state to match. Use a sub that produces the right ZF/SF/CF
    ;; This is approximate - we store the flags value for later eval_cc checks
    (global.set $flag_op (i32.const 2))
    (global.set $flag_res (i32.const 0)) ;; placeholder
    ;; ZF
    (if (i32.and (local.get $f) (i32.const 0x40))
      (then (global.set $flag_res (i32.const 0)))
      (else (global.set $flag_res (i32.const 1))))
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
        (if (i32.lt_u (local.get $b_eff) (local.get $b))
          (then (global.set $flag_a (i32.const 0xFFFFFFFF))
                (global.set $flag_res (i32.const 0))))
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
    (local $r i32)
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
    (if (i32.eq (local.get $type) (i32.const 0)) ;; ROL
      (then
        (return (i32.or
          (i32.shl (local.get $val) (local.get $count))
          (i32.shr_u (local.get $val) (i32.sub (i32.const 32) (local.get $count)))))))
    (if (i32.eq (local.get $type) (i32.const 1)) ;; ROR
      (then
        (return (i32.or
          (i32.shr_u (local.get $val) (local.get $count))
          (i32.shl (local.get $val) (i32.sub (i32.const 32) (local.get $count)))))))
    ;; RCL/RCR/SAL — treat SAL as SHL, RCL/RCR approximate
    (if (i32.eq (local.get $type) (i32.const 6)) ;; SAL = SHL
      (then
        (local.set $r (i32.shl (local.get $val) (local.get $count)))
        (call $set_flags_shift (local.get $r)
          (i32.and (i32.shr_u (local.get $val) (i32.sub (i32.const 32) (local.get $count))) (i32.const 1)))
        (return (local.get $r))))
    ;; Fallback
    (local.get $val)
  )

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
    (if (i64.eqz (local.get $divisor)) (then (call $host_exit (i32.const 0xDE00)) (return)))
    (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $dividend) (local.get $divisor))))
    (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor))))
    (call $next))
  (func $th_idiv32 (param $op i32)
    (local $divisor i64) (local $dividend i64)
    (local.set $divisor (i64.extend_i32_s (call $get_reg (local.get $op))))
    (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
    (if (i64.eqz (local.get $divisor)) (then (call $host_exit (i32.const 0xDE01)) (return)))
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
    (if (i64.eqz (local.get $divisor)) (then (call $host_exit (i32.const 0xDE02)) (return)))
    (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $dividend) (local.get $divisor))))
    (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor)))) (call $next))
  (func $th_idiv_m32 (param $op i32)
    (local $divisor i64) (local $dividend i64) (local $addr i32) (local.set $addr (call $read_thread_word))
    (local.set $divisor (i64.extend_i32_s (call $gl32 (local.get $addr))))
    (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
    (if (i64.eqz (local.get $divisor)) (then (call $host_exit (i32.const 0xDE03)) (return)))
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
    (local $alu i32) (local $d i32) (local $s i32) (local $a i32) (local $b i32) (local $r i32)
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
    (local.set $r (i32.and (i32.add (i32.add (local.get $a) (local.get $b)) (call $get_cf)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $d) (local.get $r))
    (call $set_flags_add (local.get $a) (i32.add (local.get $b) (call $get_cf)) (local.get $r)) (br $done)
    ) ;; end $sbb — SBB case
    (local.set $r (i32.and (i32.sub (i32.sub (local.get $a) (local.get $b)) (call $get_cf)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $d) (local.get $r))
    (call $set_flags_sub (local.get $a) (i32.add (local.get $b) (call $get_cf)) (local.get $r)) (br $done)
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
    (call $next))

  ;; --- Byte register-immediate ALU (op = alu_op<<8 | reg, imm in next word) ---
  (func $th_alu_r8_i8 (param $op i32)
    (local $alu i32) (local $reg i32) (local $a i32) (local $b i32) (local $r i32)
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
    (local.set $r (i32.and (i32.add (i32.add (local.get $a) (local.get $b)) (call $get_cf)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $reg) (local.get $r))
    (call $set_flags_add (local.get $a) (i32.add (local.get $b) (call $get_cf)) (local.get $r)) (br $done)
    )
    (local.set $r (i32.and (i32.sub (i32.sub (local.get $a) (local.get $b)) (call $get_cf)) (i32.const 0xFF)))
    (call $set_reg8 (local.get $reg) (local.get $r))
    (call $set_flags_sub (local.get $a) (i32.add (local.get $b) (call $get_cf)) (local.get $r)) (br $done)
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
    (if (i32.ne (local.get $alu) (i32.const 7)) (then (call $gs8 (local.get $addr) (local.get $val))))
    (call $next))

  ;; 130: reg8 OP= [base+disp]. operand = alu_op<<8 | reg<<4 | base.
  (func $th_alu_r_m8_ro (param $op i32)
    (local $addr i32) (local $alu i32) (local $reg i32) (local $val i32)
    (local.set $addr (call $ea_from_op (local.get $op)))
    (local.set $alu (i32.and (i32.shr_u (local.get $op) (i32.const 8)) (i32.const 0xF)))
    (local.set $reg (i32.and (i32.shr_u (local.get $op) (i32.const 4)) (i32.const 0xF)))
    (local.set $val (call $do_alu32 (local.get $alu) (call $get_reg8 (local.get $reg)) (call $gl8 (local.get $addr))))
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
            (if (i64.eqz (local.get $divisor)) (then (call $host_exit (i32.const 0xDE02)) (return)))
            (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $dividend) (local.get $divisor))))
            (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $dividend) (local.get $divisor))))))
    (if (i32.eq (local.get $mtype) (i32.const 3)) ;; IDIV
      (then (local.set $divisor (i64.extend_i32_s (local.get $mval)))
            (local.set $dividend (i64.or (i64.extend_i32_u (global.get $eax))
              (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
            (if (i64.eqz (local.get $divisor)) (then (call $host_exit (i32.const 0xDE03)) (return)))
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
        (then (call $te (i32.const 32) (i32.sub (local.get $op) (i32.const 0x50))) (br $decode)))
      ;; ---- POP reg (0x58-0x5F) ----
      (if (i32.and (i32.ge_u (local.get $op) (i32.const 0x58)) (i32.le_u (local.get $op) (i32.const 0x5F)))
        (then (call $te (i32.const 33) (i32.sub (local.get $op) (i32.const 0x58))) (br $decode)))
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
            (then ;; EAX, imm32 (or AX, imm16 with 0x66 prefix)
              (call $te (i32.add (i32.const 3) (local.get $imm)) (i32.const 0))
              (if (local.get $prefix_66)
                (then (call $te_raw (i32.and (call $d_fetch16) (i32.const 0xFFFF))))
                (else (call $te_raw (call $d_fetch32))))
              (br $decode)))

          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then
              ;; reg, reg — check byte vs dword
              (if (i32.and (local.get $op) (i32.const 1))
                (then ;; dword (odd opcode)
                  (if (i32.and (local.get $op) (i32.const 2))
                    (then (call $te (i32.add (i32.const 12) (local.get $imm))
                      (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))
                    (else (call $te (i32.add (i32.const 12) (local.get $imm))
                      (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))
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
                    (then (call $emit_alu_r_m32 (local.get $imm) (global.get $mr_reg)))
                    (else (call $emit_alu_r_m8 (local.get $imm) (global.get $mr_reg)))))
                (else ;; [mem], r
                  (if (i32.and (local.get $op) (i32.const 1))
                    (then (call $emit_alu_m32_r (local.get $imm) (global.get $mr_reg)))
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
                (else ;; dword reg, imm32
                  (call $te (i32.add (i32.const 3) (global.get $mr_reg)) (global.get $mr_val))
                  (call $te_raw (local.get $imm)))))
            (else ;; [mem], imm — use runtime EA
              (if (i32.or (i32.eq (local.get $op) (i32.const 0x80)) (i32.eq (local.get $op) (i32.const 0x82)))
                (then (call $emit_alu_m8_i (global.get $mr_reg) (local.get $imm)))
                (else (call $emit_alu_m32_i (global.get $mr_reg) (local.get $imm))))))
          (br $decode)))

      ;; ---- 0x84: TEST r/m8, r8 ----
      (if (i32.eq (local.get $op) (i32.const 0x84))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 150) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
            (else (call $emit_test_m8_r (global.get $mr_reg))))
          (br $decode)))

      ;; ---- 0x85: TEST r/m32, r ----
      (if (i32.eq (local.get $op) (i32.const 0x85))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 72) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))
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
                (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x89))
                (then (call $emit_store32 (global.get $mr_reg)))
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
                (else (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val))))))
            (else
              (if (i32.eq (local.get $op) (i32.const 0x8B))
                (then (call $emit_load32 (global.get $mr_reg)))
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
      (if (i32.eq (local.get $op) (i32.const 0xA1)) (then (call $te (i32.const 20) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA2)) (then (call $te (i32.const 25) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA3)) (then (call $te (i32.const 21) (i32.const 0)) (call $te_raw (call $seg_adj (call $d_fetch32) (local.get $prefix_seg))) (br $decode)))

      ;; ---- 0xC6: MOV r/m8, imm8 ----
      (if (i32.eq (local.get $op) (i32.const 0xC6))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 2) (global.get $mr_val)) (call $te_raw (local.get $imm)))
            (else (call $emit_store8_imm (local.get $imm))))
          (br $decode)))

      ;; ---- 0xC7: MOV r/m32, imm32 ----
      (if (i32.eq (local.get $op) (i32.const 0xC7))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch32))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 2) (global.get $mr_val)) (call $te_raw (local.get $imm)))
            (else (call $emit_store32_imm (local.get $imm))))
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
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
            (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))
          (br $decode)))

      ;; ---- 0xC0/0xC1: Shift group 2, imm8 ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0xC0)) (i32.eq (local.get $op) (i32.const 0xC1)))
        (then
          (call $decode_modrm)
          (local.set $imm (call $d_fetch8))
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 53) (i32.or (global.get $mr_val) (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (i32.shl (local.get $imm) (i32.const 16))))))
            (else (call $emit_shift_m32 (i32.or (i32.shl (global.get $mr_reg) (i32.const 8)) (local.get $imm)))))
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
      (if (i32.eq (local.get $op) (i32.const 0xA5)) ;; MOVSD
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 83) (i32.const 0))) (else (call $te (i32.const 87) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAA)) ;; STOSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 84) (i32.const 0))) (else (call $te (i32.const 88) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAB)) ;; STOSD
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 85) (i32.const 0))) (else (call $te (i32.const 89) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAC)) ;; LODSB
        (then (call $te (i32.const 90) (i32.const 0)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAD)) ;; LODSD
        (then (call $te (i32.const 91) (i32.const 0)) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xA6)) ;; CMPSB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 92) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 94) (i32.const 0)))) (br $decode)))
      (if (i32.eq (local.get $op) (i32.const 0xAE)) ;; SCASB
        (then (if (local.get $prefix_rep) (then (call $te (i32.const 93) (i32.sub (local.get $prefix_rep) (i32.const 1)))) (else (call $te (i32.const 95) (i32.const 0)))) (br $decode)))

      ;; ---- Misc single-byte ----
      (if (i32.eq (local.get $op) (i32.const 0x60)) (then (call $te (i32.const 35) (i32.const 0)) (br $decode))) ;; PUSHAD
      (if (i32.eq (local.get $op) (i32.const 0x61)) (then (call $te (i32.const 36) (i32.const 0)) (br $decode))) ;; POPAD
      (if (i32.eq (local.get $op) (i32.const 0x9C)) (then (call $te (i32.const 37) (i32.const 0)) (br $decode))) ;; PUSHFD
      (if (i32.eq (local.get $op) (i32.const 0x9D)) (then (call $te (i32.const 38) (i32.const 0)) (br $decode))) ;; POPFD
      (if (i32.eq (local.get $op) (i32.const 0x99)) (then (call $te (i32.const 105) (i32.const 0)) (br $decode))) ;; CDQ
      (if (i32.eq (local.get $op) (i32.const 0x98)) (then (call $te (i32.const 107) (i32.const 0)) (br $decode))) ;; CWDE (or CBW with 66 prefix)
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
              (call $te (i32.const 102) (i32.and (local.get $op) (i32.const 0xF)))
              (if (i32.eq (global.get $mr_mod) (i32.const 3))
                (then (call $te_raw (global.get $mr_val)))
                (else (call $te_raw (global.get $mr_disp)))) ;; TODO: runtime EA for SETcc mem
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
                (then ;; movzx r32, reg8
                  (call $te (i32.const 2) (global.get $mr_reg))
                  (call $te_raw (i32.const 0)) ;; placeholder, will be overwritten by handler
                  ;; Actually: we need get_reg8. Emit mov_r_r then and with 0xFF. Hack but works.
                  ;; Better: just use the existing movzx8 handler with a dummy address.
                  ;; Simplest: emit as mov_r_r then and_r_i32
                  (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                  (call $te (i32.const 7) (global.get $mr_reg)) (call $te_raw (i32.const 0xFF)))
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
                (then
                  (call $te (i32.const 11) (i32.or (i32.shl (global.get $mr_reg) (i32.const 4)) (global.get $mr_val)))
                  (call $te (i32.const 53) (i32.or (global.get $mr_reg) (i32.or (i32.shl (i32.const 4) (i32.const 8)) (i32.shl (i32.const 24) (i32.const 16)))))
                  (call $te (i32.const 53) (i32.or (global.get $mr_reg) (i32.or (i32.shl (i32.const 7) (i32.const 8)) (i32.shl (i32.const 24) (i32.const 16))))))
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
                (else (call $te (i32.const 45) (global.get $d_pc)) (local.set $done (i32.const 1)))) ;; TODO: memory bt
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

          ;; Unknown 0x0F xx
          (call $host_log_i32 (i32.or (i32.const 0x0F00) (local.get $op)))
          (call $te (i32.const 45) (i32.sub (global.get $d_pc) (i32.const 2)))
          (local.set $done (i32.const 1)) (br $decode)))

      ;; ---- XCHG r/m32, r32 (0x87) / XCHG r/m8 (0x86) ----
      (if (i32.or (i32.eq (local.get $op) (i32.const 0x86)) (i32.eq (local.get $op) (i32.const 0x87)))
        (then
          (call $decode_modrm)
          (if (i32.eq (global.get $mr_mod) (i32.const 3))
            (then (call $te (i32.const 71) (i32.or (i32.shl (global.get $mr_val) (i32.const 4)) (global.get $mr_reg)))))
          ;; TODO: memory xchg
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

    ;; Set heap to be above the image
    (global.set $heap_ptr (i32.add (global.get $image_base)
      (i32.load (i32.add (local.get $pe_off) (i32.const 80))))) ;; SizeOfImage

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
          (then (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (local.get $entry))))
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
  ;; WIN32 API DISPATCH
  ;; ============================================================
  (func $win32_dispatch (param $thunk_idx i32)
    (local $name_rva i32) (local $name_ptr i32)
    (local $arg0 i32) (local $arg1 i32) (local $arg2 i32) (local $arg3 i32)
    (local $arg4 i32)
    (local $w0 i32) (local $w1 i32) (local $w2 i32)
    (local $msg_ptr i32) (local $tmp i32) (local $packed i32)

    ;; Read name RVA from thunk data (stored at WASM addr THUNK_BASE + idx*8)
    (local.set $name_rva (i32.load (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8)))))

    ;; Catch-return thunk: catch funclet returned, EAX = continuation address
    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0000))
      (then
        ;; Pop return address (already consumed by RET that brought us here)
        ;; ESP was already adjusted by the RET. EAX has the continuation addr.
        (global.set $eip (global.get $eax))
        (return)))

    (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))

    (local.set $arg0 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (local.set $arg1 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    (local.set $arg2 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))
    (local.set $arg3 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (local.set $arg4 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))

    ;; Read first 12 bytes of name for matching
    (local.set $w0 (i32.load (local.get $name_ptr)))
    (local.set $w1 (i32.load (i32.add (local.get $name_ptr) (i32.const 4))))
    (local.set $w2 (i32.load (i32.add (local.get $name_ptr) (i32.const 8))))

    ;; DEBUG: log API name
    (call $host_log (local.get $name_ptr) (i32.const 32))

    ;; ================================================================
    ;; KERNEL32
    ;; ================================================================

    ;; ExitProcess(1) "Exit"=0x74697845
    (if (i32.eq (local.get $w0) (i32.const 0x74697845))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
            (call $host_exit (local.get $arg0)) (global.set $eip (i32.const 0)) (global.set $steps (i32.const 0)) (return)))

    ;; GetModuleHandleA(1) "GetM"+"odul"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746547)) (i32.eq (local.get $w1) (i32.const 0x6C75646F)))
      (then (global.set $eax (global.get $image_base))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetCommandLineA(0) "GetC"+"omma"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x616D6D6F)))
      (then (call $store_fake_cmdline) (global.set $eax (global.get $fake_cmdline_addr))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; GetStartupInfoA(1) "GetS"+"tart"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x74726174)))
      (then (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 68))
            (call $gs32 (local.get $arg0) (i32.const 68))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetProcAddress(2) "GetP"+"rocA"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x41636F72)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetLastError(0) "GetL"+"astE"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x45747361)))
      (then (global.set $eax (global.get $last_error))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; GetLocalTime(1) "GetL"+"ocal" + 'T' at pos 8
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x6C61636F)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 8))) (i32.const 0x54))) ;; 'T'
      (then (call $zero_memory (call $g2w (local.get $arg0)) (i32.const 16))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetTimeFormatA(6) "GetT"+"imeF"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x46656D69)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; GetDateFormatA(6) "GetD"+"ateF"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x46657461)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; GetProfileStringA(5) "GetP"+"rofi" + char10='S'
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x69666F72)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 10))) (i32.const 0x53)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; GetProfileIntA(3) "GetP"+"rofi" + char10='I' — return default (arg2)
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x69666F72)))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 10))) (i32.const 0x49)))
      (then (global.set $eax (local.get $arg2))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetLocaleInfoA(4) "GetL"+"ocal"+"eInf"
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x6C61636F)))
                 (i32.eq (local.get $w2) (i32.const 0x666E4965)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LoadLibraryA(1) "Load"+"Libr"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x7262694C)))
      (then (global.set $eax (i32.const 0x7FFE0000))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DeleteFileA(1) "Dele"+"teFi"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656C6544)) (i32.eq (local.get $w1) (i32.const 0x69466574)))
      (then (global.set $eax (i32.const 0)) (global.set $last_error (i32.const 2))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateFileA(7) "Crea"+"teFi"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x69466574)))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)))

    ;; FindFirstFileA(2) "Find"+"Firs"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x73726946)))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; FindClose(1) "Find"+"Clos"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x736F6C43)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; MulDiv(3) "MulD"
    (if (i32.eq (local.get $w0) (i32.const 0x446C754D))
      (then
        (if (i32.eqz (local.get $arg2))
          (then (global.set $eax (i32.const -1)))
          (else (global.set $eax (i32.wrap_i64 (i64.div_s
                  (i64.mul (i64.extend_i32_s (local.get $arg0)) (i64.extend_i32_s (local.get $arg1)))
                  (i64.extend_i32_s (local.get $arg2)))))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; RtlMoveMemory(3) "RtlM"
    (if (i32.eq (local.get $w0) (i32.const 0x4D6C7452))
      (then (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; _lcreat(2) "_lcr"
    (if (i32.eq (local.get $w0) (i32.const 0x72636C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; _lopen(2) "_lop"
    (if (i32.eq (local.get $w0) (i32.const 0x706F6C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; _lwrite(3) "_lwr"
    (if (i32.eq (local.get $w0) (i32.const 0x72776C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; _llseek(3) "_lls"
    (if (i32.eq (local.get $w0) (i32.const 0x736C6C5F))
      (then (global.set $eax (i32.const 0xFFFFFFFF))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))
    ;; _lclose(1) "_lcl"
    (if (i32.eq (local.get $w0) (i32.const 0x6C636C5F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    ;; _lread(3) "_lre"
    (if (i32.eq (local.get $w0) (i32.const 0x65726C5F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; Sleep(1) "Slee"=0x65656C53
    (if (i32.eq (local.get $w0) (i32.const 0x65656C53))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CloseHandle(1) "Clos"+"eHan"=0x6E614865
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x736F6C43)) (i32.eq (local.get $w1) (i32.const 0x6E614865)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateEventA(4) "Crea"+"teEv"=0x76456574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x76456574)))
      (then (global.set $eax (i32.const 0x70001)) ;; fake event handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; CreateThread(6) "Crea"+"teTh"=0x68546574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x68546574)))
      (then (global.set $eax (i32.const 0x70002)) ;; fake thread handle
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; WaitForSingleObject(2) "Wait"=0x74696157
    (if (i32.eq (local.get $w0) (i32.const 0x74696157))
      (then (global.set $eax (i32.const 0)) ;; WAIT_OBJECT_0
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; ResetEvent(1) "Rese"=0x65736552
    (if (i32.eq (local.get $w0) (i32.const 0x65736552))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; SetEvent(1) "SetE"+"vent"=0x746E6576
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x45746553)) (i32.eq (local.get $w1) (i32.const 0x746E6576)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; WriteProfileStringA(3) "Writ"=0x74697257
    (if (i32.eq (local.get $w0) (i32.const 0x74697257))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; Local* / Global* — memory management
    (if (i32.eq (local.get $w0) (i32.const 0x61636F4C)) ;; "Loca"
      (then (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2)) (return)))
    (if (i32.eq (local.get $w0) (i32.const 0x626F6C47)) ;; "Glob"
      (then (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2)) (return)))

    ;; lstr* — string functions
    (if (i32.eq (local.get $w0) (i32.const 0x7274736C)) ;; "lstr"
      (then (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2)) (return)))

    ;; ================================================================
    ;; USER32
    ;; ================================================================

    ;; RegisterClassA / RegisterClassExA(1) "Regi"+"ster"+"Clas"
    ;; Distinguish by byte 13: 'E' (0x45) = ExA (WNDCLASSEX, wndproc at +8), 'A' (0x41) = A (WNDCLASSA, wndproc at +4)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x69676552)) (i32.eq (local.get $w2) (i32.const 0x73616C43)))
      (then
        (if (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 13))) (i32.const 0x45)) ;; 'E' = ExA
          (then ;; WNDCLASSEX: lpfnWndProc at +8
            (global.set $wndproc_addr (call $gl32 (i32.add (local.get $arg0) (i32.const 8)))))
          (else ;; WNDCLASSA: lpfnWndProc at +4
            (global.set $wndproc_addr (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))))
        (global.set $eax (i32.const 0xC001))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; RegisterWindowMessageA(1) "Regi"+"ster"+"Wind"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x69676552)) (i32.eq (local.get $w2) (i32.const 0x646E6957)))
      (then (global.set $eax (i32.const 0xC100))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateWindowExA(12) "Crea"+"teWi"
    ;; Args: exStyle(+4), className(+8), windowName(+12), style(+16), x(+20), y(+24), w(+28), h(+32), parent(+36), menu(+40)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x69576574)))
      (then
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
        ;; Flag to deliver WM_CREATE as first message in GetMessageA
        (if (i32.eq (global.get $next_hwnd) (global.get $main_hwnd))
          (then (global.set $pending_wm_create (i32.const 1))))
        (global.set $eax (global.get $next_hwnd))
        (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 52))) (return)))

    ;; CreateDialogParamA(5) "Crea"+"teDi"
    ;; Args: hInstance(+4), templateName(+8), hWndParent(+12), dlgProc(+16), initParam(+20)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x69446574)))
      (then
        ;; Save dialog hwnd for IsChild/SendMessage routing
        (global.set $dlg_hwnd (i32.const 0x10002))
        ;; Call host: create_dialog(hwnd, dlg_resource_id)
        (global.set $eax (call $host_create_dialog
          (i32.const 0x10002)    ;; hwnd for dialog
          (local.get $arg1)))    ;; template name/ID
        (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; MessageBoxA(4) "Mess"
    (if (i32.eq (local.get $w0) (i32.const 0x7373654D))
      (then
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
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; ShowWindow(2) "Show"
    (if (i32.eq (local.get $w0) (i32.const 0x776F6853))
      (then (call $host_show_window (local.get $arg0) (local.get $arg1))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; UpdateWindow(1) "Upda"
    (if (i32.eq (local.get $w0) (i32.const 0x61647055))
      (then (call $host_invalidate (local.get $arg0))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetMessageA(4) "GetM"+"essa"
    ;; Returns 0 when WM_QUIT → exits message loop
    ;; We send a few synthetic messages then WM_QUIT
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746547)) (i32.eq (local.get $w1) (i32.const 0x61737365)))
      (then
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
        (if (global.get $pending_wm_create)
          (then
            (global.set $pending_wm_create (i32.const 0))
            (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))
        ;; First call: send WM_PAINT
        (if (i32.eqz (global.get $msg_phase))
          (then
            (global.set $msg_phase (i32.const 1))
            (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x000F)) ;; WM_PAINT
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
            (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
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
        ;; No input available — return WM_NULL so loop keeps spinning
        (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
        (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0))  ;; WM_NULL
        (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
        (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; PeekMessageA(5) "Peek"
    (if (i32.eq (local.get $w0) (i32.const 0x6B656550))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; DispatchMessageA(1) "Disp"
    (if (i32.eq (local.get $w0) (i32.const 0x70736944))
      (then
        ;; Skip WM_NULL — idle message, don't dispatch to WndProc
        (if (i32.eqz (call $gl32 (i32.add (local.get $arg0) (i32.const 4))))
          (then (global.set $eax (i32.const 0))
                (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
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
            ;; Jump to WndProc
            (global.set $eip (global.get $wndproc_addr))
            (global.set $steps (i32.const 0))
            (return)))
        ;; No WndProc: just return 0
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; TranslateAcceleratorA(3) "Tran"+"slat"+"eAcc" — MUST match before TranslateMessage
    ;; w2 = "eAcc" = 0x63634165
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x6E617254))
                          (i32.eq (local.get $w1) (i32.const 0x74616C73)))
                 (i32.eq (local.get $w2) (i32.const 0x63634165)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; TranslateMessage(1) "Tran"+"slat" (remaining match after AcceleratorA excluded)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6E617254)) (i32.eq (local.get $w1) (i32.const 0x74616C73)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DefWindowProcA(4) "DefW"
    ;; Args: hwnd(+4), msg(+8), wParam(+12), lParam(+16)
    (if (i32.eq (local.get $w0) (i32.const 0x57666544))
      (then
        ;; WM_CLOSE (0x10): call DestroyWindow(hwnd)
        (if (i32.eq (local.get $arg1) (i32.const 0x0010))
          (then
            ;; DestroyWindow sends WM_DESTROY to WndProc
            ;; For now, just set quit_flag directly since WM_DESTROY→PostQuitMessage
            (global.set $quit_flag (i32.const 1))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; PostQuitMessage(1) "Post"+"Quit"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736F50)) (i32.eq (local.get $w1) (i32.const 0x74697551)))
      (then (global.set $quit_flag (i32.const 1))
            (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; PostMessageA(4) "Post"+"Mess"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736F50)) (i32.eq (local.get $w1) (i32.const 0x7373654D)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SendMessageA(4) "Send"+"Mess"
    ;; Args: hwnd(+4), msg(+8), wParam(+12), lParam(+16)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6553)) (i32.eq (local.get $w1) (i32.const 0x7373654D)))
      (then
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
            ;; Jump to WndProc
            (global.set $eip (global.get $wndproc_addr))
            (global.set $steps (i32.const 0))
            (return)))
        ;; Non-main window or no WndProc: stub — return 0
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SendDlgItemMessageA(5) "Send"+"DlgI"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6553)) (i32.eq (local.get $w1) (i32.const 0x49676C44)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; DestroyWindow(1) "Dest"+"royW"
    ;; Sets quit_flag — real implementation would send WM_DESTROY then WM_NCDESTROY
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736544)) (i32.eq (local.get $w1) (i32.const 0x57796F72)))
      (then (global.set $quit_flag (i32.const 1))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DestroyMenu(1) "Dest"+"royM"=0x4D796F72
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74736544)) (i32.eq (local.get $w1) (i32.const 0x4D796F72)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetDC(1) "GetD"+"C\0" — match "GetD" then check 5th char = 'C'
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x43)))
      (then (global.set $eax (i32.const 0x50001)) ;; fake HDC
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetDeviceCaps(2) "GetD"+"evic"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x63697665)))
      (then
        ;; Return reasonable defaults for common caps
        ;; HORZRES=8, VERTRES=10, LOGPIXELSX=88, LOGPIXELSY=90
        (if (i32.eq (local.get $arg1) (i32.const 8))
          (then (global.set $eax (i32.const 800))))  ;; HORZRES
        (if (i32.eq (local.get $arg1) (i32.const 10))
          (then (global.set $eax (i32.const 600))))  ;; VERTRES
        (if (i32.eq (local.get $arg1) (i32.const 88))
          (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSX
        (if (i32.eq (local.get $arg1) (i32.const 90))
          (then (global.set $eax (i32.const 96))))   ;; LOGPIXELSY
        (if (i32.and (i32.ne (local.get $arg1) (i32.const 8))
              (i32.and (i32.ne (local.get $arg1) (i32.const 10))
                (i32.and (i32.ne (local.get $arg1) (i32.const 88))
                         (i32.ne (local.get $arg1) (i32.const 90)))))
          (then (global.set $eax (i32.const 0))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetMenu(1) "GetM"+"enu\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746547))
                 (i32.eq (i32.and (local.get $w1) (i32.const 0x00FFFFFF)) (i32.const 0x00756E65)))
      (then (global.set $eax (i32.const 0x40001)) ;; fake HMENU
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetSubMenu(2) "GetS"+"ubMe"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x654D6275)))
      (then (global.set $eax (i32.const 0x40002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetSystemMenu(2) "GetS"+"yste"+"mMen"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547))
                 (i32.eq (local.get $w1) (i32.const 0x65747379)))
      (then
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
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetClientRect(2) "GetC"+"lien"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x6E65696C)))
      (then
        ;; Fill RECT with 800x600
        (call $gs32 (local.get $arg1) (i32.const 0))       ;; left
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))   ;; top
        (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 800)) ;; right
        (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 600));; bottom
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetWindowTextA(3) "GetW"+"indo" + w2="wTex"=0x78655477
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746547)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x78655477)))
      (then
        ;; Return empty string
        (if (i32.gt_u (local.get $arg2) (i32.const 0))
          (then (call $gs8 (local.get $arg1) (i32.const 0))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetWindowRect(2) "GetW"+"indo" + w2="wRec"=0x63655277
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746547)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x63655277)))
      (then
        (call $gs32 (local.get $arg1) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 640))
        (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 480))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetDlgCtrlID(1) "GetD"+"lgCt"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x7443676C)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetDlgItemTextA(4) "GetD"+"lgIt" + w2="emTe"=0x65546D65
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
                 (i32.eq (local.get $w2) (i32.const 0x65546D65)))
      (then
        (if (i32.gt_u (local.get $arg3) (i32.const 0))
          (then (call $gs8 (local.get $arg2) (i32.const 0))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; GetDlgItem(2) "GetD"+"lgIt" + w2 != "emTe" (shorter name)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x44746547)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetCursorPos(1) "GetC"+"urso"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x6F737275)))
      (then
        (call $gs32 (local.get $arg0) (i32.const 0))
        (call $gs32 (i32.add (local.get $arg0) (i32.const 4)) (i32.const 0))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetLastActivePopup(1) "GetL"+"astA"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4C746547)) (i32.eq (local.get $w1) (i32.const 0x41747361)))
      (then (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetFocus(0) "GetF"+"ocus"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746547)) (i32.eq (local.get $w1) (i32.const 0x7375636F)))
      (then (global.set $eax (global.get $main_hwnd))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ReleaseDC(2) "Rele"
    (if (i32.eq (local.get $w0) (i32.const 0x656C6552))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetWindowLongA(3) "SetW"+"indo"+"wLon"
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746553)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x6E6F4C77)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; SetWindowTextA(2) "SetW"+"indo"+"wTex" — args: hWnd, lpString
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746553)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x78655477)))
      (then (call $host_set_window_text (local.get $arg0) (call $g2w (local.get $arg1)))
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetDlgItemTextA(3) "SetD"+"lgIt" + w2="emTe"=0x65546D65
    ;; Args: hDlg(+4), nIDDlgItem(+8), lpString(+12)
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x44746553)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
                 (i32.eq (local.get $w2) (i32.const 0x65546D65)))
      (then
        (call $host_set_dlg_item_text
          (local.get $arg0)                          ;; hDlg
          (local.get $arg1)                          ;; nIDDlgItem
          (call $g2w (local.get $arg2)))             ;; lpString → WASM ptr
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; SetDlgItemInt(4) "SetD"+"lgIt" + w2="emIn"=0x6E496D65
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x44746553)) (i32.eq (local.get $w1) (i32.const 0x7449676C)))
                 (i32.eq (local.get $w2) (i32.const 0x6E496D65)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SetForegroundWindow(1) "SetF"+"oreg"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746553)) (i32.eq (local.get $w1) (i32.const 0x6765726F)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; SetCursor(1) "SetC"+"urso"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746553)) (i32.eq (local.get $w1) (i32.const 0x6F737275)))
      (then (global.set $eax (i32.const 0x20001))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; SetFocus(1) "SetF"+"ocus"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746553)) (i32.eq (local.get $w1) (i32.const 0x7375636F)))
      (then (global.set $eax (global.get $main_hwnd))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; LoadCursorA(2) "Load"+"Curs"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x73727543)))
      (then (global.set $eax (i32.const 0x20001))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; LoadIconA(2) "Load"+"Icon"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x6E6F6349)))
      (then (global.set $eax (i32.const 0x20002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; LoadStringA(4) "Load"+"Stri" — args: hInst, uID, lpBuffer, cchMax
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x69727453)))
      (then
        ;; Call host to write string from resource JSON into guest buffer
        (global.set $eax (call $host_load_string
          (local.get $arg1)                ;; string ID
          (call $g2w (local.get $arg2))    ;; buffer (WASM ptr)
          (local.get $arg3)))              ;; max chars
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LoadAcceleratorsA(2) "Load"+"Acce"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x65636341)))
      (then (global.set $haccel (i32.const 0x60001))
            (global.set $eax (i32.const 0x60001))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; EnableWindow(2) "Enab"+"leWi"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x62616E45)) (i32.eq (local.get $w1) (i32.const 0x6957656C)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; EnableMenuItem(3) "Enab"+"leMen"
    (if (i32.eq (local.get $w0) (i32.const 0x62616E45))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; EndDialog(2) "EndD"
    (if (i32.eq (local.get $w0) (i32.const 0x44646E45))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; InvalidateRect(3) "Inva"
    (if (i32.eq (local.get $w0) (i32.const 0x61766E49))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; MoveWindow(6) "Move"
    (if (i32.eq (local.get $w0) (i32.const 0x65766F4D))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; CheckMenuRadioItem(5) "Chec"+"kMen"+"uRad"=0x64615275
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x6E654D6B)))
                 (i32.eq (local.get $w2) (i32.const 0x64615275)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; CheckMenuItem(3) "Chec"+"kMen" (catch-all for remaining CheckMenu*)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x6E654D6B)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; CheckRadioButton(4) "Chec"+"kRad"=0x6461526B
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x6461526B)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; CheckDlgButton(3) "Chec"+"kDlg"=0x676C446B
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63656843)) (i32.eq (local.get $w1) (i32.const 0x676C446B)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; CharNextA(1) "Char"+"Next"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72616843)) (i32.eq (local.get $w1) (i32.const 0x7478654E)))
      (then
        ;; Return ptr+1 (simple ANSI impl)
        (if (i32.eqz (call $gl8 (local.get $arg0)))
          (then (global.set $eax (local.get $arg0)))
          (else (global.set $eax (i32.add (local.get $arg0) (i32.const 1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CharPrevA(2) "Char"+"Prev"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72616843)) (i32.eq (local.get $w1) (i32.const 0x76657250)))
      (then
        ;; Return max(start, ptr-1)
        (if (i32.le_u (local.get $arg1) (local.get $arg0))
          (then (global.set $eax (local.get $arg0)))
          (else (global.set $eax (i32.sub (local.get $arg1) (i32.const 1)))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; IsDialogMessageA(2) "IsDi"
    (if (i32.eq (local.get $w0) (i32.const 0x69447349))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; IsIconic(1) "IsIc"
    (if (i32.eq (local.get $w0) (i32.const 0x63497349))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ChildWindowFromPoint(3) "Chil"
    (if (i32.eq (local.get $w0) (i32.const 0x6C696843))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; ScreenToClient(2) "Scre"
    (if (i32.eq (local.get $w0) (i32.const 0x65726353))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; TabbedTextOutA(8) "Tabb"
    (if (i32.eq (local.get $w0) (i32.const 0x62626154))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 36))) (return)))

    ;; WinHelpA(4) "WinH"
    (if (i32.eq (local.get $w0) (i32.const 0x486E6957))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; wsprintfA — CDECL! Caller cleans stack. Only pop ret addr.
    (if (i32.eq (local.get $w0) (i32.const 0x69727077)) ;; "wpri" (wsprintfA = "wspr")
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))
    ;; Better match for wsprintfA: "wspr"
    (if (i32.eq (local.get $w0) (i32.const 0x72707377))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; Clipboard
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x736F6C43)) (i32.eq (local.get $w1) (i32.const 0x696C4365))) ;; "Clos"+"eCli" CloseClipboard(0)
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))
    (if (i32.eq (local.get $w0) (i32.const 0x6E65704F)) ;; "Open" OpenClipboard(1)
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.eq (local.get $w0) (i32.const 0x6C437349)) ;; "IsCl" IsClipboardFormatAvailable(1)
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; IsChild(2) "IsCh"=0x68437349
    ;; Args: hWndParent(+4), hWnd(+8)
    ;; Return TRUE if hWndParent is the dialog — all controls are children of it
    (if (i32.eq (local.get $w0) (i32.const 0x68437349))
      (then (global.set $eax (if (result i32) (i32.and
              (i32.ne (global.get $dlg_hwnd) (i32.const 0))
              (i32.eq (local.get $arg0) (global.get $dlg_hwnd)))
              (then (i32.const 1)) (else (i32.const 0))))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetSysColorBrush(1) "GetS"+"ysCo"=0x6F437379 + w2="lorB"=0x42726F6C
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6F437379)))
                 (i32.eq (local.get $w2) (i32.const 0x42726F6C)))
      (then (global.set $eax (i32.const 0x30010)) ;; fake HBRUSH
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetSysColor(1) "GetS"+"ysCo"=0x6F437379 (catch-all after Brush)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6F437379)))
      (then
        ;; Return reasonable defaults for common colors
        ;; COLOR_WINDOW=5 → white, COLOR_BTNFACE=15 → 0xC0C0C0
        (if (i32.eq (local.get $arg0) (i32.const 5))
          (then (global.set $eax (i32.const 0x00FFFFFF)))
          (else (if (i32.eq (local.get $arg0) (i32.const 15))
            (then (global.set $eax (i32.const 0x00C0C0C0)))
            (else (global.set $eax (i32.const 0x00C0C0C0))))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DialogBoxParamA(5) "Dial"=0x6C616944
    (if (i32.eq (local.get $w0) (i32.const 0x6C616944))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; LoadMenuA(2) "Load"+"Menu"=0x756E654D — args: hInst, lpMenuName
    ;; Return HMENU = 0x40000 | resourceId so SetMenu can decode it
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x64616F4C)) (i32.eq (local.get $w1) (i32.const 0x756E654D)))
      (then (global.set $eax (i32.or (i32.const 0x40000) (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; TrackPopupMenuEx(6) "Trac"=0x63617254
    (if (i32.eq (local.get $w0) (i32.const 0x63617254))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; OffsetRect(3) "Offs"=0x7366664F
    (if (i32.eq (local.get $w0) (i32.const 0x7366664F))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; MapWindowPoints(4) "MapW"=0x5770614D
    (if (i32.eq (local.get $w0) (i32.const 0x5770614D))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SetWindowPos(7) "SetW"+"indo"+"wPos"=0x736F5077
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x57746553)) (i32.eq (local.get $w1) (i32.const 0x6F646E69)))
                 (i32.eq (local.get $w2) (i32.const 0x736F5077)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 32))) (return)))

    ;; DrawTextA(5) "Draw"+"Text"=0x74786554
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x77617244)) (i32.eq (local.get $w1) (i32.const 0x74786554)))
      (then (global.set $eax (i32.const 16)) ;; return text height
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; DrawEdge(4) "Draw"+"Edge"=0x65676445
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x77617244)) (i32.eq (local.get $w1) (i32.const 0x65676445)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; GetClipboardData(1) "GetC"+"lipb"=0x62706C69
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746547)) (i32.eq (local.get $w1) (i32.const 0x62706C69)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ================================================================
    ;; GDI32
    ;; ================================================================

    ;; SelectObject(2) "Sele"
    (if (i32.eq (local.get $w0) (i32.const 0x656C6553))
      (then (global.set $eax (call $host_gdi_select_object (local.get $arg0) (local.get $arg1)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; DeleteObject(1) "Dele"+"teOb"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656C6544)) (i32.eq (local.get $w1) (i32.const 0x624F6574)))
      (then (global.set $eax (call $host_gdi_delete_object (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; DeleteDC(1) "Dele"+"teDC"
    (if (i32.eq (local.get $w0) (i32.const 0x656C6544))
      (then (global.set $eax (call $host_gdi_delete_dc (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreatePen(3) "Crea"+"tePe"=0x65506574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x65506574)))
      (then (global.set $eax (call $host_gdi_create_pen (local.get $arg0) (local.get $arg1) (local.get $arg2)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; CreateSolidBrush(1) "Crea"+"teSo"=0x6F536574
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F536574)))
      (then (global.set $eax (call $host_gdi_create_solid_brush (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateCompatibleDC(1) "Crea"+"teCo"+"mpat"+"ible"+"DC\0" — must match before CreateCompatibleBitmap
    ;; "teCo" = 0x6F436574, "mpat" = 0x7461706D
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F436574)))
                 (i32.eq (local.get $w2) (i32.const 0x7461706D)))
      (then (global.set $eax (call $host_gdi_create_compat_dc (local.get $arg0)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateCompatibleBitmap(3) "Crea"+"teCo" — DC matched above, this catches Bitmap
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F436574)))
      (then (global.set $eax (call $host_gdi_create_compat_bitmap (local.get $arg0) (local.get $arg1) (local.get $arg2)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetViewportOrgEx(2) "GetV"+"iewp"=0x70776569
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x56746547)) (i32.eq (local.get $w1) (i32.const 0x70776569)))
      (then
        ;; Fill POINT with (0,0)
        (if (i32.ne (local.get $arg1) (i32.const 0))
          (then
            (call $gs32 (local.get $arg1) (i32.const 0))
            (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; Rectangle(5) "Rect"+"angl"=0x6C676E61
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74636552)) (i32.eq (local.get $w1) (i32.const 0x6C676E61)))
      (then (global.set $eax (call $host_gdi_rectangle
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; MoveToEx(4) "Move"+"ToEx"=0x78456F54
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65766F4D)) (i32.eq (local.get $w1) (i32.const 0x78456F54)))
      (then
        ;; Save old position to lpPoint (arg3) if non-null
        (global.set $eax (call $host_gdi_move_to (local.get $arg0) (local.get $arg1) (local.get $arg2)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LineTo(3) "Line"+"To\0\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656E694C)) (i32.eq (i32.and (local.get $w1) (i32.const 0x0000FFFF)) (i32.const 0x00006F54)))
      (then (global.set $eax (call $host_gdi_line_to (local.get $arg0) (local.get $arg1) (local.get $arg2) (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; Ellipse(5) "Elli"+"pse\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x696C6C45)) (i32.eq (i32.and (local.get $w1) (i32.const 0x00FFFFFF)) (i32.const 0x00657370)))
      (then (global.set $eax (call $host_gdi_ellipse
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 24))) (return)))

    ;; Arc(9) "Arc\0" — need args 5-8 from deeper in the stack
    (if (i32.eq (i32.and (local.get $w0) (i32.const 0x00FFFFFF)) (i32.const 0x00637241))
      (then (global.set $eax (call $host_gdi_arc
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
              (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
              (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)))

    ;; BitBlt(9) "BitB"+"lt\0\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x42746942)) (i32.eq (i32.and (local.get $w1) (i32.const 0x0000FFFF)) (i32.const 0x0000746C)))
      (then (global.set $eax (call $host_gdi_bitblt
              (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)
              (call $gl32 (i32.add (global.get $esp) (i32.const 24)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 28)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 32)))
              (call $gl32 (i32.add (global.get $esp) (i32.const 36)))
              (global.get $main_hwnd)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 40))) (return)))

    ;; GetStockObject(1) "GetS"+"tock"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x6B636F74)))
      (then (global.set $eax (i32.const 0x30002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetObjectA(3) "GetO"+"bjec"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4F746547)) (i32.eq (local.get $w1) (i32.const 0x63656A62)))
      (then
        (if (i32.gt_u (local.get $arg1) (i32.const 0))
          (then (call $zero_memory (call $g2w (local.get $arg2)) (local.get $arg1))))
        (global.set $eax (local.get $arg1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; GetTextMetricsA(2) "GetT"+"extM"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x4D747865)))
      (then
        ;; Fill TEXTMETRIC with reasonable defaults
        (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 56))
        (call $gs32 (local.get $arg1) (i32.const 16))           ;; tmHeight
        (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))  ;; tmAscent (unused detail)
        (call $gs32 (i32.add (local.get $arg1) (i32.const 20)) (i32.const 8)) ;; tmAveCharWidth
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; GetTextExtentPointA(4) "GetT"+"extE"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x45747865)))
      (then
        ;; Fill SIZE: cx = count*8, cy = 16
        (call $gs32 (local.get $arg3) (i32.mul (local.get $arg2) (i32.const 8)))  ;; cx
        (call $gs32 (i32.add (local.get $arg3) (i32.const 4)) (i32.const 16))     ;; cy
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; GetTextCharset(1) "GetT"+"extC"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746547)) (i32.eq (local.get $w1) (i32.const 0x43747865)))
      (then (global.set $eax (i32.const 0)) ;; ANSI_CHARSET
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateFontIndirectA(1) "Crea"+"teFo"+"ntIn" — must come before CreateFontA
    (if (i32.and (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F466574)))
                 (i32.eq (local.get $w2) (i32.const 0x6E49746E)))
      (then (global.set $eax (i32.const 0x30003))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CreateFontA(14) "Crea"+"teFo"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x6F466574)))
      (then (global.set $eax (i32.const 0x30003))
            (global.set $esp (i32.add (global.get $esp) (i32.const 60))) (return)))

    ;; CreateDCA(4) "Crea"+"teDC"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x61657243)) (i32.eq (local.get $w1) (i32.const 0x43446574)))
      (then (global.set $eax (i32.const 0x50002))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SetAbortProc(2) "SetA"
    (if (i32.eq (local.get $w0) (i32.const 0x41746553))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetBkColor(2) "SetB"+"kCol"=0x6C6F436B
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x42746553)) (i32.eq (local.get $w1) (i32.const 0x6C6F436B)))
      (then (global.set $eax (i32.const 0x00FFFFFF)) ;; prev color
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetBkMode(2) "SetB"+"kMod"=0x646F4D6B (catch-all for remaining SetB*)
    (if (i32.eq (local.get $w0) (i32.const 0x42746553))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetTextColor(2) "SetT"+"extC"=0x43747865
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746553)) (i32.eq (local.get $w1) (i32.const 0x43747865)))
      (then (global.set $eax (i32.const 0x00000000)) ;; prev color (black)
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetMenu(2) "SetM"+"enu\0" — args: hWnd, hMenu
    ;; Decode HMENU: resource ID = hMenu & 0xFFFF
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4D746553)) (i32.eq (local.get $w1) (i32.const 0x00756E65)))
      (then (call $host_set_menu
              (local.get $arg0)                                       ;; hWnd
              (i32.and (local.get $arg1) (i32.const 0xFFFF)))         ;; resource ID from HMENU
            (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetMapMode(2) "SetM"
    (if (i32.eq (local.get $w0) (i32.const 0x4D746553))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetWindowExtEx(4) / SetViewportExtEx(4) "SetW"/"SetV"
    (if (i32.or (i32.eq (local.get $w0) (i32.const 0x57746553))
                (i32.eq (local.get $w0) (i32.const 0x56746553)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; LPtoDP(3) "LPto"
    (if (i32.eq (local.get $w0) (i32.const 0x6F74504C))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; StartDocA(2) "Star"+"tDoc"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72617453)) (i32.eq (local.get $w1) (i32.const 0x636F4474)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; StartPage(1) "Star"+"tPag"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x72617453)) (i32.eq (local.get $w1) (i32.const 0x67615074)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; EndPage(1) "EndP"+"age\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50646E45))
                 (i32.eq (i32.and (local.get $w1) (i32.const 0x00FFFFFF)) (i32.const 0x00656761)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; EndPaint(2) "EndP"+"aint"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50646E45)) (i32.eq (local.get $w1) (i32.const 0x746E6961)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; EndDoc(1) "EndD"+"oc\0" — careful, "EndD" also matches EndDialog
    ;; EndDialog already matched above. EndDoc would need w1 check.
    ;; Actually EndDialog w1 = "ialo", EndDoc w1 = "oc\0\0"
    ;; EndDialog already returned above, so EndDoc won't reach here. Good.

    ;; AbortDoc(1) "Abor"
    (if (i32.eq (local.get $w0) (i32.const 0x726F6241))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; BeginPaint / EndPaint — not in IAT but useful
    ;; "Begi" BeginPaint(2)
    (if (i32.eq (local.get $w0) (i32.const 0x69676542))
      (then
        ;; Fill PAINTSTRUCT minimally
        (call $zero_memory (call $g2w (local.get $arg1)) (i32.const 64))
        (call $gs32 (local.get $arg1) (i32.const 0x50001)) ;; hdc
        (global.set $eax (i32.const 0x50001))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))
    ;; "EndP"+"aint" EndPaint(2)
    ;; "EndP" already matches EndPage above. Need to disambiguate.
    ;; EndPage: "EndP"+"age\0", EndPaint: "EndP"+"aint"
    ;; EndPage already returned. If we reach here with "EndP", it's EndPaint.
    ;; But EndPage returns first, so EndPaint won't match. Let me fix:
    ;; Remove the EndPage match above and handle both here.

    ;; --- Additional USER32 APIs ---

    ;; SetCapture(1) "SetC"+"aptu"=0x75747061
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x43746553)) (i32.eq (local.get $w1) (i32.const 0x75747061)))
      (then (global.set $eax (i32.const 0)) ;; prev capture hwnd (none)
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ReleaseCapture(0) "Rele"+"aseC"=0x43657361
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x656C6552)) (i32.eq (local.get $w1) (i32.const 0x43657361)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ShowCursor(1) "Show"+"Curs"=0x73727543
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x776F6853)) (i32.eq (local.get $w1) (i32.const 0x73727543)))
      (then (global.set $eax (i32.const 1)) ;; display count
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; KillTimer(2) "Kill"+"Time"=0x656D6954
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6C6C694B)) (i32.eq (local.get $w1) (i32.const 0x656D6954)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; SetTimer(4) "SetT"+"imer"=0x72656D69
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x54746553)) (i32.eq (local.get $w1) (i32.const 0x72656D69)))
      (then (global.set $eax (local.get $arg1)) ;; return timer ID
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; FindWindowA(2) "Find"+"Wind"=0x646E6957
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x646E6957)))
      (then (global.set $eax (i32.const 0)) ;; not found
            (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; BringWindowToTop(1) "Brin"+"gWin"=0x6E695767
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6E697242)) (i32.eq (local.get $w1) (i32.const 0x6E695767)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; WinHelpA(4) "WinH"+"elpA"=0x41706C65
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x486E6957)) (i32.eq (local.get $w1) (i32.const 0x41706C65)))
      (then (global.set $eax (i32.const 1))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; --- KERNEL32: Profile APIs ---

    ;; GetPrivateProfileIntA(4) "GetP"+"riva"=0x61766972
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x50746547)) (i32.eq (local.get $w1) (i32.const 0x61766972)))
      (then (global.set $eax (local.get $arg2)) ;; return nDefault
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; WritePrivateProfileStringA(4) "Writ"+"ePri"=0x69725065
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x74697257)) (i32.eq (local.get $w1) (i32.const 0x69725065)))
      (then (global.set $eax (i32.const 1)) ;; success
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; ================================================================
    ;; SHELL32
    ;; ================================================================

    ;; ShellExecuteA(6) "Shel"+"lExe"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6C656853)) (i32.eq (local.get $w1) (i32.const 0x6578456C)))
      (then (global.set $eax (i32.const 33)) ;; > 32 means success
            (global.set $esp (i32.add (global.get $esp) (i32.const 28))) (return)))

    ;; ShellAboutA(4) "Shel"+"lAbo" — (hWnd, szApp, szOtherStuff, hIcon)
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x6C656853)) (i32.eq (local.get $w1) (i32.const 0x6F62416C)))
      (then (global.set $eax (call $host_shell_about (local.get $arg0) (call $g2w (local.get $arg1))))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; SHGetSpecialFolderPathA(4) "SHGe"
    (if (i32.eq (local.get $w0) (i32.const 0x65474853))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; DragAcceptFiles(2) "Drag"+"Acce"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x67617244)) (i32.eq (local.get $w1) (i32.const 0x65636341)))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; DragQueryFileA(4) "Drag"+"Quer"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x67617244)) (i32.eq (local.get $w1) (i32.const 0x72657551)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 20))) (return)))

    ;; DragFinish(1) "Drag"+"Fini"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x67617244)) (i32.eq (local.get $w1) (i32.const 0x696E6946)))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; ================================================================
    ;; comdlg32
    ;; ================================================================

    ;; GetOpenFileNameA(1) / GetSaveFileNameA(1) "GetO"+"penF" / "GetS"+"aveF"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x4F746547)) (i32.eq (local.get $w1) (i32.const 0x466E6570)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x53746547)) (i32.eq (local.get $w1) (i32.const 0x46657661)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; GetFileTitleA(3) "GetF"+"ileT"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x46746547)) (i32.eq (local.get $w1) (i32.const 0x54656C69)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)))

    ;; ChooseFontA(1) "Choo"
    (if (i32.eq (local.get $w0) (i32.const 0x6F6F6843))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; FindTextA(1) — comdlg32 "Find"+"Text"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x646E6946)) (i32.eq (local.get $w1) (i32.const 0x74786554)))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; PageSetupDlgA(1) "Page"
    (if (i32.eq (local.get $w0) (i32.const 0x65676150))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)))

    ;; CommDlgExtendedError(0) "Comm"
    (if (i32.eq (local.get $w0) (i32.const 0x6D6D6F43))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ================================================================
    ;; ADVAPI32 — Registry
    ;; ================================================================
    (if (i32.eq (i32.load16_u (local.get $name_ptr)) (i32.const 0x6552)) ;; "Re"
      (then (call $dispatch_reg (local.get $name_ptr)) (return)))

    ;; ================================================================
    ;; MSVCRT — All cdecl: only pop return address (4 bytes). Caller cleans args.
    ;; ================================================================

    ;; exit(1) "exit"=0x74697865
    (if (i32.eq (local.get $w0) (i32.const 0x74697865))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
            (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)))
    ;; _exit(1) "_exi"=0x6978655F
    (if (i32.eq (local.get $w0) (i32.const 0x6978655F))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
            (call $host_exit (local.get $arg0)) (global.set $steps (i32.const 0)) (return)))

    ;; __getmainargs(4) "__ge"=0x65675F5F — fills argc/argv/envp
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x65675F5F)) (i32.eq (local.get $w1) (i32.const 0x69616D74)))
      (then
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
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; __p__fmode(0) "__p_"=0x705F5F  — returns pointer to _fmode global
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x5F705F5F)) (i32.eq (local.get $w1) (i32.const 0x6F6D665F)))
      (then
        (if (i32.eqz (global.get $msvcrt_fmode_ptr))
          (then (global.set $msvcrt_fmode_ptr (call $heap_alloc (i32.const 4)))
                (call $gs32 (global.get $msvcrt_fmode_ptr) (i32.const 0))))
        (global.set $eax (global.get $msvcrt_fmode_ptr))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; __p__commode(0) "__p_"+"_com"=0x6D6F635F
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x5F705F5F)) (i32.eq (local.get $w1) (i32.const 0x6D6F635F)))
      (then
        (if (i32.eqz (global.get $msvcrt_commode_ptr))
          (then (global.set $msvcrt_commode_ptr (call $heap_alloc (i32.const 4)))
                (call $gs32 (global.get $msvcrt_commode_ptr) (i32.const 0))))
        (global.set $eax (global.get $msvcrt_commode_ptr))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _initterm(2) "_ini"=0x696E695F — calls function pointer table, stub as no-op
    (if (i32.eq (local.get $w0) (i32.const 0x696E695F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _controlfp(2) "_con"=0x6E6F635F
    (if (i32.eq (local.get $w0) (i32.const 0x6E6F635F))
      (then (global.set $eax (i32.const 0x0009001F)) ;; default FP control word
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _acmdln — data import, returns pointer to command line string
    (if (i32.eq (local.get $w0) (i32.const 0x646D635F)) ;; "_cmd" — wait, _acmdln = "_acm"
      (then (nop))) ;; dead
    (if (i32.eq (local.get $w0) (i32.const 0x6D63615F)) ;; "_acm"
      (then
        (if (i32.eqz (global.get $msvcrt_acmdln_ptr))
          (then
            (global.set $msvcrt_acmdln_ptr (call $heap_alloc (i32.const 32)))
            (i32.store (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 0x434C4143))
            (i32.store8 (i32.add (call $g2w (global.get $msvcrt_acmdln_ptr)) (i32.const 4)) (i32.const 0))))
        (global.set $eax (global.get $msvcrt_acmdln_ptr))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _strrev(1) "_str"=0x7274735F + "ev\0"
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x7274735F))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x65))) ;; 'e' in _strrev
      (then (global.set $eax (local.get $arg0)) ;; return the pointer (stub: don't actually reverse)
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; toupper(1) "toup"=0x70756F74
    (if (i32.eq (local.get $w0) (i32.const 0x70756F74))
      (then
        ;; Simple ASCII toupper
        (if (i32.and (i32.ge_u (local.get $arg0) (i32.const 0x61)) (i32.le_u (local.get $arg0) (i32.const 0x7A)))
          (then (global.set $eax (i32.sub (local.get $arg0) (i32.const 0x20))))
          (else (global.set $eax (local.get $arg0))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; memmove(3) "memm"=0x6D6D656D
    (if (i32.eq (local.get $w0) (i32.const 0x6D6D656D))
      (then (call $memcpy (call $g2w (local.get $arg0)) (call $g2w (local.get $arg1)) (local.get $arg2))
            (global.set $eax (local.get $arg0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; strchr(2) "strc"=0x63727473
    (if (i32.and (i32.eq (local.get $w0) (i32.const 0x63727473))
                 (i32.eq (i32.load8_u (i32.add (local.get $name_ptr) (i32.const 4))) (i32.const 0x68))) ;; 'h' in strchr
      (then (global.set $eax (i32.const 0)) ;; not found (stub)
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _XcptFilter(2) "_Xcp"=0x70635F58... actually "_Xcp"
    (if (i32.eq (local.get $w0) (i32.const 0x70635858)) ;; wrong, let me recalc
      (then (nop))) ;; placeholder
    ;; "_Xcp" = 5F 58 63 70 = 0x7063585F
    (if (i32.eq (local.get $w0) (i32.const 0x7063585F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; _CxxThrowException(2) "_Cxx"=0x7878435F  — cdecl, 2 args
    ;; arg0 = exception object ptr, arg1 = ThrowInfo ptr
    ;; Walk SEH chain, find matching C++ catch handler, unwind and dispatch.
    (if (i32.eq (local.get $w0) (i32.const 0x7878435F))
      (then
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
        (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)))

    ;; _EH_prolog — stack frame setup for structured exception handling
    ;; "_EH_"=0x5F48455F
    ;; On entry: EAX = funcinfo/handler ptr, [ESP] = return addr
    ;; Stack layout after:
    ;;   [EBP+0]=old_ebp, [EBP-4]=-1 (trylevel), [EBP-8]=handler, [EBP-C]=prev_SEH
    ;;   SEH record at EBP-C: {next=old_fs:[0], handler=EAX}
    ;;   fs:[0] = EBP-C (new SEH chain head)
    (if (i32.eq (local.get $w0) (i32.const 0x5F48455F))
      (then
        (local.set $tmp (call $gl32 (global.get $esp))) ;; save return addr
        ;; Replace [ESP] with old EBP (this becomes [EBP+0] = saved EBP)
        (call $gs32 (global.get $esp) (global.get $ebp))
        ;; Set EBP = ESP (pointing to saved EBP)
        (global.set $ebp (global.get $esp))
        ;; Push -1 (trylevel)
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (i32.const -1))           ;; [EBP-4] = trylevel
        ;; Push handler (EAX) — this is also the SEH record's handler field
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $eax))        ;; [EBP-8] = handler
        ;; Push old SEH chain head (fs:[0]) — this is the SEH record's next field
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (call $gl32 (global.get $fs_base))) ;; [EBP-C] = prev SEH
        ;; Register new SEH frame: fs:[0] = &[EBP-C] = ESP
        (call $gs32 (global.get $fs_base) (global.get $esp))
        ;; EAX = EBP (matches real _EH_prolog behavior)
        (global.set $eax (global.get $ebp))
        ;; Return to caller
        (global.set $eip (local.get $tmp))
        (return)))

    ;; Generic _* CRT stubs — cdecl, only pop return address
    (if (i32.eq (i32.load8_u (local.get $name_ptr)) (i32.const 0x5F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; C++ mangled names ??* — thiscall/cdecl, pop ret only
    (if (i32.eq (i32.load16_u (local.get $name_ptr)) (i32.const 0x3F3F))
      (then (global.set $eax (i32.const 0))
            (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)))

    ;; ================================================================
    ;; FALLBACK — log and return 0
    ;; ================================================================
    (call $host_log (local.get $name_ptr) (i32.const 48))
    ;; Stack hexdump: ret addr + 6 args
    (call $host_log_i32 (call $gl32 (global.get $esp)))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (call $host_log_i32 (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (global.set $eax (i32.const 0))
    ;; Conservative: pop ret + 4 args = 20. May be wrong but better than crashing.
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; Sub-dispatchers for grouped APIs
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
        ;; lstrcmpA(2) / lstrcmpiA(2) — return 0 (equal) as stub
        (global.set $eax (i32.const 0))
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
  ;; Apply segment override to an address (FS=5 adds fs_base)
  (func $seg_adj (param $addr i32) (param $seg i32) (result i32)
    (if (result i32) (i32.eq (local.get $seg) (i32.const 5))
      (then (i32.add (local.get $addr) (global.get $fs_base)))
      (else (local.get $addr))))

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
  (func $heap_alloc (param $size i32) (result i32)
    (local $ptr i32) (local.set $ptr (global.get $heap_ptr))
    (global.set $heap_ptr (i32.and (i32.add (i32.add (global.get $heap_ptr) (local.get $size)) (i32.const 7)) (i32.const 0xFFFFFFF8)))
    (local.get $ptr))

  ;; heap_free: no-op for now (bump allocator)
  (func $heap_free (param $guest_ptr i32))
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

  ;; Get GUEST_BASE for direct WASM memory access
  (func (export "get_guest_base") (result i32) (global.get $GUEST_BASE))
)
