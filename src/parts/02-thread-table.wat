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
  )

