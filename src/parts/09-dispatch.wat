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
      (br_table $api_0 $api_1 $api_2 $api_3 $api_4 $api_5 $api_6 $api_7 $api_8 $api_9 $api_10 $api_11 $api_12 $api_13 $api_14 $api_15 $api_16 $api_17 $api_18 $api_19 $api_20 $api_21 $api_22 $api_23 $api_24 $api_25 $api_26 $api_27 $api_28 $api_29 $api_30 $api_31 $api_32 $api_33 $api_34 $api_35 $api_36 $api_37 $api_38 $api_39 $api_40 $api_41 $api_42 $api_43 $api_44 $api_45 $api_46 $api_47 $api_48 $api_49 $api_50 $api_51 $api_52 $api_53 $api_54 $api_55 $api_56 $api_57 $api_58 $api_59 $api_60 $api_61 $api_62 $api_63 $api_64 $api_65 $api_66 $api_67 $api_68 $api_69 $api_70 $api_71 $api_72 $api_73 $api_74 $api_75 $api_76 $api_77 $api_78 $api_79 $api_80 $api_81 $api_82 $api_83 $api_84 $api_85 $api_86 $api_87 $api_88 $api_89 $api_90 $api_91 $api_92 $api_93 $api_94 $api_95 $api_96 $api_97 $api_98 $api_99 $api_100 $api_101 $api_102 $api_103 $api_104 $api_105 $api_106 $api_107 $api_108 $api_109 $api_110 $api_111 $api_112 $api_113 $api_114 $api_115 $api_116 $api_117 $api_118 $api_119 $api_120 $api_121 $api_122 $api_123 $api_124 $api_125 $api_126 $api_127 $api_128 $api_129 $api_130 $api_131 $api_132 $api_133 $api_134 $api_135 $api_136 $api_137 $api_138 $api_139 $api_140 $api_141 $api_142 $api_143 $api_144 $api_145 $api_146 $api_147 $api_148 $api_149 $api_150 $api_151 $api_152 $api_153 $api_154 $api_155 $api_156 $api_157 $api_158 $api_159 $api_160 $api_161 $api_162 $api_163 $api_164 $api_165 $api_166 $api_167 $api_168 $api_169 $api_170 $api_171 $api_172 $api_173 $api_174 $api_175 $api_176 $api_177 $api_178 $api_179 $api_180 $api_181 $api_182 $api_183 $api_184 $api_185 $api_186 $api_187 $api_188 $api_189 $api_190 $api_191 $api_192 $api_193 $api_194 $api_195 $api_196 $api_197 $api_198 $api_199 $api_200 $api_201 $api_202 $api_203 $api_204 $api_205 $api_206 $api_207 $api_208 $api_209 $api_210 $api_211 $api_212 $api_213 $api_214 $api_215 $api_216 $api_217 $api_218 $api_219 $api_220 $api_221 $api_222 $api_223 $api_224 $api_225 $api_226 $api_227 $api_228 $api_229 $api_230 $api_231 $api_232 $api_233 $api_234 $api_235 $api_236 $api_237 $api_238 $api_239 $api_240 $api_241 $api_242 $api_243 $api_244 $api_245 $api_246 $api_247 $api_248 $api_249 $api_250 $api_251 $api_252 $api_253 $api_254 $api_255 $api_256 $fallback (local.get $api_id))
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
      ;; Allocate a small block with double-NUL terminator
      (local.set $tmp (call $heap_alloc (i32.const 4)))
      (call $gs32 (local.get $tmp) (i32.const 0))
      (global.set $eax (local.get $tmp))
      ;; GetEnvironmentStrings(0) vs GetEnvironmentStringsW(0) — both pop 4
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
      (global.set $eax (i32.const 100000)) ;; fake tick count
      (global.set $esp (i32.add (global.get $esp) (i32.const 4))) (return)
    (return)
    ) ;; 59: FindResourceA
      (global.set $eax (i32.const 0x90001)) ;; fake resource handle
      (global.set $esp (i32.add (global.get $esp) (i32.const 16))) (return)
    (return)
    ) ;; 60: LoadResource
      (global.set $eax (i32.const 0x90002)) ;; fake global handle
      (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
    (return)
    ) ;; 61: LockResource
      (global.set $eax (local.get $arg0)) ;; return the handle as pointer
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
      (if (global.get $pending_wm_create)
      (then
      (global.set $pending_wm_create (i32.const 0))
      (call $gs32 (local.get $msg_ptr) (global.get $main_hwnd))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 4)) (i32.const 0x0001)) ;; WM_CREATE
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 8)) (i32.const 0))
      (call $gs32 (i32.add (local.get $msg_ptr) (i32.const 12)) (i32.const 0))
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
      (call $gs32 (global.get $esp) (i32.const 100000)) ;; dwTime (fake tick count)
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
      (then (global.set $eax (i32.const 800))))  ;; HORZRES
      (if (i32.eq (local.get $arg1) (i32.const 10))
      (then (global.set $eax (i32.const 600))))  ;; VERTRES
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
    ) ;; 90: GetSystemMetrics
      (global.set $eax (i32.const 640))
      (global.set $esp (i32.add (global.get $esp) (i32.const 8))) (return)
    (return)
    ) ;; 91: GetClientRect
      ;; Fill RECT with 800x600
      (call $gs32 (local.get $arg1) (i32.const 0))       ;; left
      (call $gs32 (i32.add (local.get $arg1) (i32.const 4)) (i32.const 0))   ;; top
      (call $gs32 (i32.add (local.get $arg1) (i32.const 8)) (i32.const 800)) ;; right
      (call $gs32 (i32.add (local.get $arg1) (i32.const 12)) (i32.const 600));; bottom
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
      ;; Allocate a small block with double-NUL terminator
      (local.set $tmp (call $heap_alloc (i32.const 4)))
      (call $gs32 (local.get $tmp) (i32.const 0))
      (global.set $eax (local.get $tmp))
      ;; GetEnvironmentStrings(0) vs GetEnvironmentStringsW(0) — both pop 4
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


