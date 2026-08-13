  ;; GENERATED from the canonical $th_* handler functions.
  ;; See tools/generate-full-brtable-dispatch.js.
  (func $run_x86_full_brtable_packet (param $auto_thread i32)
    (local $auto_fn i32) (local $auto_op i32)
    (local $auto_i32_0 i32)
    (local $auto_i32_1 i32)
    (local $auto_i32_2 i32)
    (local $auto_i32_3 i32)
    (local $auto_i32_4 i32)
    (local $auto_i32_5 i32)
    (local $auto_i32_6 i32)
    (local $auto_i32_7 i32)
    (local $auto_i32_8 i32)
    (local $auto_i32_9 i32)
    (local $auto_i32_10 i32)
    (local $auto_i32_11 i32)
    (local $auto_i32_12 i32)
    (local $auto_i32_13 i32)
    (local $auto_i32_14 i32)
    (local $auto_i32_15 i32)
    (local $auto_i32_16 i32)
    (local $auto_i32_17 i32)
    (local $auto_i32_18 i32)
    (local $auto_i32_19 i32)
    (local $auto_i32_20 i32)
    (local $auto_i32_21 i32)
    (local $auto_i32_22 i32)
    (local $auto_i32_23 i32)
    (local $auto_i32_24 i32)
    (local $auto_i32_25 i32)
    (local $auto_i32_26 i32)
    (local $auto_i32_27 i32)
    (local $auto_i32_28 i32)
    (local $auto_i32_29 i32)
    (local $auto_i64_0 i64)
    (local $auto_i64_1 i64)
    (local $auto_i64_2 i64)
    (local $auto_i64_3 i64)
    (local $auto_i64_4 i64)
    (global.set $ip (local.get $auto_thread))
    (global.set $steps (i32.const 1000))
    (block $auto_done (loop $auto_dispatch
      (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))
      (br_if $auto_done (i32.le_s (global.get $steps) (i32.const 0)))
      (local.set $auto_fn (i32.load (global.get $ip)))
      (local.set $auto_op (i32.load offset=4 (global.get $ip)))
      (global.set $ip (i32.add (global.get $ip) (i32.const 8)))
      (block $auto_corrupt
        (block $auto_case_384
        (block $auto_case_383
        (block $auto_case_382
        (block $auto_case_381
        (block $auto_case_380
        (block $auto_case_379
        (block $auto_case_378
        (block $auto_case_377
        (block $auto_case_376
        (block $auto_case_375
        (block $auto_case_374
        (block $auto_case_373
        (block $auto_case_372
        (block $auto_case_371
        (block $auto_case_370
        (block $auto_case_369
        (block $auto_case_368
        (block $auto_case_367
        (block $auto_case_366
        (block $auto_case_365
        (block $auto_case_364
        (block $auto_case_363
        (block $auto_case_362
        (block $auto_case_361
        (block $auto_case_360
        (block $auto_case_359
        (block $auto_case_358
        (block $auto_case_357
        (block $auto_case_356
        (block $auto_case_355
        (block $auto_case_354
        (block $auto_case_353
        (block $auto_case_352
        (block $auto_case_351
        (block $auto_case_350
        (block $auto_case_349
        (block $auto_case_348
        (block $auto_case_347
        (block $auto_case_346
        (block $auto_case_345
        (block $auto_case_344
        (block $auto_case_343
        (block $auto_case_342
        (block $auto_case_341
        (block $auto_case_340
        (block $auto_case_339
        (block $auto_case_338
        (block $auto_case_337
        (block $auto_case_336
        (block $auto_case_335
        (block $auto_case_334
        (block $auto_case_333
        (block $auto_case_332
        (block $auto_case_331
        (block $auto_case_330
        (block $auto_case_329
        (block $auto_case_328
        (block $auto_case_327
        (block $auto_case_326
        (block $auto_case_325
        (block $auto_case_324
        (block $auto_case_323
        (block $auto_case_322
        (block $auto_case_321
        (block $auto_case_320
        (block $auto_case_319
        (block $auto_case_318
        (block $auto_case_317
        (block $auto_case_316
        (block $auto_case_315
        (block $auto_case_314
        (block $auto_case_313
        (block $auto_case_312
        (block $auto_case_311
        (block $auto_case_310
        (block $auto_case_309
        (block $auto_case_308
        (block $auto_case_307
        (block $auto_case_306
        (block $auto_case_305
        (block $auto_case_304
        (block $auto_case_303
        (block $auto_case_302
        (block $auto_case_301
        (block $auto_case_300
        (block $auto_case_299
        (block $auto_case_298
        (block $auto_case_297
        (block $auto_case_296
        (block $auto_case_295
        (block $auto_case_294
        (block $auto_case_293
        (block $auto_case_292
        (block $auto_case_291
        (block $auto_case_290
        (block $auto_case_289
        (block $auto_case_288
        (block $auto_case_287
        (block $auto_case_286
        (block $auto_case_285
        (block $auto_case_284
        (block $auto_case_283
        (block $auto_case_282
        (block $auto_case_281
        (block $auto_case_280
        (block $auto_case_279
        (block $auto_case_278
        (block $auto_case_277
        (block $auto_case_276
        (block $auto_case_275
        (block $auto_case_274
        (block $auto_case_273
        (block $auto_case_272
        (block $auto_case_271
        (block $auto_case_270
        (block $auto_case_269
        (block $auto_case_268
        (block $auto_case_267
        (block $auto_case_266
        (block $auto_case_265
        (block $auto_case_264
        (block $auto_case_263
        (block $auto_case_262
        (block $auto_case_261
        (block $auto_case_260
        (block $auto_case_259
        (block $auto_case_258
        (block $auto_case_257
        (block $auto_case_256
        (block $auto_case_255
        (block $auto_case_254
        (block $auto_case_253
        (block $auto_case_252
        (block $auto_case_251
        (block $auto_case_250
        (block $auto_case_249
        (block $auto_case_248
        (block $auto_case_247
        (block $auto_case_246
        (block $auto_case_245
        (block $auto_case_244
        (block $auto_case_243
        (block $auto_case_242
        (block $auto_case_241
        (block $auto_case_240
        (block $auto_case_239
        (block $auto_case_238
        (block $auto_case_237
        (block $auto_case_236
        (block $auto_case_235
        (block $auto_case_234
        (block $auto_case_233
        (block $auto_case_232
        (block $auto_case_231
        (block $auto_case_230
        (block $auto_case_229
        (block $auto_case_228
        (block $auto_case_227
        (block $auto_case_226
        (block $auto_case_225
        (block $auto_case_224
        (block $auto_case_223
        (block $auto_case_222
        (block $auto_case_221
        (block $auto_case_220
        (block $auto_case_219
        (block $auto_case_218
        (block $auto_case_217
        (block $auto_case_216
        (block $auto_case_215
        (block $auto_case_214
        (block $auto_case_213
        (block $auto_case_212
        (block $auto_case_211
        (block $auto_case_210
        (block $auto_case_209
        (block $auto_case_208
        (block $auto_case_207
        (block $auto_case_206
        (block $auto_case_205
        (block $auto_case_204
        (block $auto_case_203
        (block $auto_case_202
        (block $auto_case_201
        (block $auto_case_200
        (block $auto_case_199
        (block $auto_case_198
        (block $auto_case_197
        (block $auto_case_196
        (block $auto_case_195
        (block $auto_case_194
        (block $auto_case_193
        (block $auto_case_192
        (block $auto_case_191
        (block $auto_case_190
        (block $auto_case_189
        (block $auto_case_188
        (block $auto_case_187
        (block $auto_case_186
        (block $auto_case_185
        (block $auto_case_184
        (block $auto_case_183
        (block $auto_case_182
        (block $auto_case_181
        (block $auto_case_180
        (block $auto_case_179
        (block $auto_case_178
        (block $auto_case_177
        (block $auto_case_176
        (block $auto_case_175
        (block $auto_case_174
        (block $auto_case_173
        (block $auto_case_172
        (block $auto_case_171
        (block $auto_case_170
        (block $auto_case_169
        (block $auto_case_168
        (block $auto_case_167
        (block $auto_case_166
        (block $auto_case_165
        (block $auto_case_164
        (block $auto_case_163
        (block $auto_case_162
        (block $auto_case_161
        (block $auto_case_160
        (block $auto_case_159
        (block $auto_case_158
        (block $auto_case_157
        (block $auto_case_156
        (block $auto_case_155
        (block $auto_case_154
        (block $auto_case_153
        (block $auto_case_152
        (block $auto_case_151
        (block $auto_case_150
        (block $auto_case_149
        (block $auto_case_148
        (block $auto_case_147
        (block $auto_case_146
        (block $auto_case_145
        (block $auto_case_144
        (block $auto_case_143
        (block $auto_case_142
        (block $auto_case_141
        (block $auto_case_140
        (block $auto_case_139
        (block $auto_case_138
        (block $auto_case_137
        (block $auto_case_136
        (block $auto_case_135
        (block $auto_case_134
        (block $auto_case_133
        (block $auto_case_132
        (block $auto_case_131
        (block $auto_case_130
        (block $auto_case_129
        (block $auto_case_128
        (block $auto_case_127
        (block $auto_case_126
        (block $auto_case_125
        (block $auto_case_124
        (block $auto_case_123
        (block $auto_case_122
        (block $auto_case_121
        (block $auto_case_120
        (block $auto_case_119
        (block $auto_case_118
        (block $auto_case_117
        (block $auto_case_116
        (block $auto_case_115
        (block $auto_case_114
        (block $auto_case_113
        (block $auto_case_112
        (block $auto_case_111
        (block $auto_case_110
        (block $auto_case_109
        (block $auto_case_108
        (block $auto_case_107
        (block $auto_case_106
        (block $auto_case_105
        (block $auto_case_104
        (block $auto_case_103
        (block $auto_case_102
        (block $auto_case_101
        (block $auto_case_100
        (block $auto_case_99
        (block $auto_case_98
        (block $auto_case_97
        (block $auto_case_96
        (block $auto_case_95
        (block $auto_case_94
        (block $auto_case_93
        (block $auto_case_92
        (block $auto_case_91
        (block $auto_case_90
        (block $auto_case_89
        (block $auto_case_88
        (block $auto_case_87
        (block $auto_case_86
        (block $auto_case_85
        (block $auto_case_84
        (block $auto_case_83
        (block $auto_case_82
        (block $auto_case_81
        (block $auto_case_80
        (block $auto_case_79
        (block $auto_case_78
        (block $auto_case_77
        (block $auto_case_76
        (block $auto_case_75
        (block $auto_case_74
        (block $auto_case_73
        (block $auto_case_72
        (block $auto_case_71
        (block $auto_case_70
        (block $auto_case_69
        (block $auto_case_68
        (block $auto_case_67
        (block $auto_case_66
        (block $auto_case_65
        (block $auto_case_64
        (block $auto_case_63
        (block $auto_case_62
        (block $auto_case_61
        (block $auto_case_60
        (block $auto_case_59
        (block $auto_case_58
        (block $auto_case_57
        (block $auto_case_56
        (block $auto_case_55
        (block $auto_case_54
        (block $auto_case_53
        (block $auto_case_52
        (block $auto_case_51
        (block $auto_case_50
        (block $auto_case_49
        (block $auto_case_48
        (block $auto_case_47
        (block $auto_case_46
        (block $auto_case_45
        (block $auto_case_44
        (block $auto_case_43
        (block $auto_case_42
        (block $auto_case_41
        (block $auto_case_40
        (block $auto_case_39
        (block $auto_case_38
        (block $auto_case_37
        (block $auto_case_36
        (block $auto_case_35
        (block $auto_case_34
        (block $auto_case_33
        (block $auto_case_32
        (block $auto_case_31
        (block $auto_case_30
        (block $auto_case_29
        (block $auto_case_28
        (block $auto_case_27
        (block $auto_case_26
        (block $auto_case_25
        (block $auto_case_24
        (block $auto_case_23
        (block $auto_case_22
        (block $auto_case_21
        (block $auto_case_20
        (block $auto_case_19
        (block $auto_case_18
        (block $auto_case_17
        (block $auto_case_16
        (block $auto_case_15
        (block $auto_case_14
        (block $auto_case_13
        (block $auto_case_12
        (block $auto_case_11
        (block $auto_case_10
        (block $auto_case_9
        (block $auto_case_8
        (block $auto_case_7
        (block $auto_case_6
        (block $auto_case_5
        (block $auto_case_4
        (block $auto_case_3
        (block $auto_case_2
        (block $auto_case_1
        (block $auto_case_0
          (br_table $auto_case_0 $auto_case_1 $auto_case_2 $auto_case_3 $auto_case_4 $auto_case_5 $auto_case_6 $auto_case_7 $auto_case_8 $auto_case_9 $auto_case_10 $auto_case_11 $auto_case_12 $auto_case_13 $auto_case_14 $auto_case_15 $auto_case_16 $auto_case_17 $auto_case_18 $auto_case_19 $auto_case_20 $auto_case_21 $auto_case_22 $auto_case_23 $auto_case_24 $auto_case_25 $auto_case_26 $auto_case_27 $auto_case_28 $auto_case_29 $auto_case_30 $auto_case_31 $auto_case_32 $auto_case_33 $auto_case_34 $auto_case_35 $auto_case_36 $auto_case_37 $auto_case_38 $auto_case_39 $auto_case_40 $auto_case_41 $auto_case_42 $auto_case_43 $auto_case_44 $auto_case_45 $auto_case_46 $auto_case_47 $auto_case_48 $auto_case_49 $auto_case_50 $auto_case_51 $auto_case_52 $auto_case_53 $auto_case_54 $auto_case_55 $auto_case_56 $auto_case_57 $auto_case_58 $auto_case_59 $auto_case_60 $auto_case_61 $auto_case_62 $auto_case_63 $auto_case_64 $auto_case_65 $auto_case_66 $auto_case_67 $auto_case_68 $auto_case_69 $auto_case_70 $auto_case_71 $auto_case_72 $auto_case_73 $auto_case_74 $auto_case_75 $auto_case_76 $auto_case_77 $auto_case_78 $auto_case_79 $auto_case_80 $auto_case_81 $auto_case_82 $auto_case_83 $auto_case_84 $auto_case_85 $auto_case_86 $auto_case_87 $auto_case_88 $auto_case_89 $auto_case_90 $auto_case_91 $auto_case_92 $auto_case_93 $auto_case_94 $auto_case_95 $auto_case_96 $auto_case_97 $auto_case_98 $auto_case_99 $auto_case_100 $auto_case_101 $auto_case_102 $auto_case_103 $auto_case_104 $auto_case_105 $auto_case_106 $auto_case_107 $auto_case_108 $auto_case_109 $auto_case_110 $auto_case_111 $auto_case_112 $auto_case_113 $auto_case_114 $auto_case_115 $auto_case_116 $auto_case_117 $auto_case_118 $auto_case_119 $auto_case_120 $auto_case_121 $auto_case_122 $auto_case_123 $auto_case_124 $auto_case_125 $auto_case_126 $auto_case_127 $auto_case_128 $auto_case_129 $auto_case_130 $auto_case_131 $auto_case_132 $auto_case_133 $auto_case_134 $auto_case_135 $auto_case_136 $auto_case_137 $auto_case_138 $auto_case_139 $auto_case_140 $auto_case_141 $auto_case_142 $auto_case_143 $auto_case_144 $auto_case_145 $auto_case_146 $auto_case_147 $auto_case_148 $auto_case_149 $auto_case_150 $auto_case_151 $auto_case_152 $auto_case_153 $auto_case_154 $auto_case_155 $auto_case_156 $auto_case_157 $auto_case_158 $auto_case_159 $auto_case_160 $auto_case_161 $auto_case_162 $auto_case_163 $auto_case_164 $auto_case_165 $auto_case_166 $auto_case_167 $auto_case_168 $auto_case_169 $auto_case_170 $auto_case_171 $auto_case_172 $auto_case_173 $auto_case_174 $auto_case_175 $auto_case_176 $auto_case_177 $auto_case_178 $auto_case_179 $auto_case_180 $auto_case_181 $auto_case_182 $auto_case_183 $auto_case_184 $auto_case_185 $auto_case_186 $auto_case_187 $auto_case_188 $auto_case_189 $auto_case_190 $auto_case_191 $auto_case_192 $auto_case_193 $auto_case_194 $auto_case_195 $auto_case_196 $auto_case_197 $auto_case_198 $auto_case_199 $auto_case_200 $auto_case_201 $auto_case_202 $auto_case_203 $auto_case_204 $auto_case_205 $auto_case_206 $auto_case_207 $auto_case_208 $auto_case_209 $auto_case_210 $auto_case_211 $auto_case_212 $auto_case_213 $auto_case_214 $auto_case_215 $auto_case_216 $auto_case_217 $auto_case_218 $auto_case_219 $auto_case_220 $auto_case_221 $auto_case_222 $auto_case_223 $auto_case_224 $auto_case_225 $auto_case_226 $auto_case_227 $auto_case_228 $auto_case_229 $auto_case_230 $auto_case_231 $auto_case_232 $auto_case_233 $auto_case_234 $auto_case_235 $auto_case_236 $auto_case_237 $auto_case_238 $auto_case_239 $auto_case_240 $auto_case_241 $auto_case_242 $auto_case_243 $auto_case_244 $auto_case_245 $auto_case_246 $auto_case_247 $auto_case_248 $auto_case_249 $auto_case_250 $auto_case_251 $auto_case_252 $auto_case_253 $auto_case_254 $auto_case_255 $auto_case_256 $auto_case_257 $auto_case_258 $auto_case_259 $auto_case_260 $auto_case_261 $auto_case_262 $auto_case_263 $auto_case_264 $auto_case_265 $auto_case_266 $auto_case_267 $auto_case_268 $auto_case_269 $auto_case_270 $auto_case_271 $auto_case_272 $auto_case_273 $auto_case_274 $auto_case_275 $auto_case_276 $auto_case_277 $auto_case_278 $auto_case_279 $auto_case_280 $auto_case_281 $auto_case_282 $auto_case_283 $auto_case_284 $auto_case_285 $auto_case_286 $auto_case_287 $auto_case_288 $auto_case_289 $auto_case_290 $auto_case_291 $auto_case_292 $auto_case_293 $auto_case_294 $auto_case_295 $auto_case_296 $auto_case_297 $auto_case_298 $auto_case_299 $auto_case_300 $auto_case_301 $auto_case_302 $auto_case_303 $auto_case_304 $auto_case_305 $auto_case_306 $auto_case_307 $auto_case_308 $auto_case_309 $auto_case_310 $auto_case_311 $auto_case_312 $auto_case_313 $auto_case_314 $auto_case_315 $auto_case_316 $auto_case_317 $auto_case_318 $auto_case_319 $auto_case_320 $auto_case_321 $auto_case_322 $auto_case_323 $auto_case_324 $auto_case_325 $auto_case_326 $auto_case_327 $auto_case_328 $auto_case_329 $auto_case_330 $auto_case_331 $auto_case_332 $auto_case_333 $auto_case_334 $auto_case_335 $auto_case_336 $auto_case_337 $auto_case_338 $auto_case_339 $auto_case_340 $auto_case_341 $auto_case_342 $auto_case_343 $auto_case_344 $auto_case_345 $auto_case_346 $auto_case_347 $auto_case_348 $auto_case_349 $auto_case_350 $auto_case_351 $auto_case_352 $auto_case_353 $auto_case_354 $auto_case_355 $auto_case_356 $auto_case_357 $auto_case_358 $auto_case_359 $auto_case_360 $auto_case_361 $auto_case_362 $auto_case_363 $auto_case_364 $auto_case_365 $auto_case_366 $auto_case_367 $auto_case_368 $auto_case_369 $auto_case_370 $auto_case_371 $auto_case_372 $auto_case_373 $auto_case_374 $auto_case_375 $auto_case_376 $auto_case_377 $auto_case_378 $auto_case_379 $auto_case_380 $auto_case_381 $auto_case_382 $auto_case_383 $auto_case_384 $auto_corrupt (local.get $auto_fn))
        ) ;; 0: $th_nop
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 1: $th_next_word
        (drop (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 2: $th_mov_r_i32
        (call $set_reg (local.get $auto_op) (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 3: $th_add_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_2))
        (call $set_flags_add (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 4: $th_or_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.or (call $get_reg (local.get $auto_op)) (call $read_thread_word)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (call $set_flags_logic (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 5: $th_adc_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_3 (i32.add (local.get $auto_i32_1) (call $get_cf)))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (local.get $auto_i32_3)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_2))
        (call $set_flags_add (local.get $auto_i32_0) (local.get $auto_i32_3) (local.get $auto_i32_2))
        (if (i32.lt_u (local.get $auto_i32_3) (local.get $auto_i32_1)) (then (global.set $flag_op (i32.const 8)) (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 6: $th_sbb_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_3 (i32.add (local.get $auto_i32_1) (call $get_cf)))
        (local.set $auto_i32_2 (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_3)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_2))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_3) (local.get $auto_i32_2))
        (if (i32.lt_u (local.get $auto_i32_3) (local.get $auto_i32_1)) (then (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 7: $th_and_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $get_reg (local.get $auto_op)) (call $read_thread_word)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (call $set_flags_logic (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 8: $th_sub_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_2))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 9: $th_xor_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.xor (call $get_reg (local.get $auto_op)) (call $read_thread_word)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (call $set_flags_logic (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 10: $th_cmp_r_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 11: $th_mov_r_r
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 0) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 7)) (i32.const 3)) (i32.and (local.get $auto_op) (i32.const 7))))))
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 12: $th_add_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 1) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 7)) (i32.const 3)) (i32.and (local.get $auto_op) (i32.const 7))))))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (local.set $auto_i32_3 (i32.add (local.get $auto_i32_1) (local.get $auto_i32_2)))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_3))
        (call $set_flags_add (local.get $auto_i32_1) (local.get $auto_i32_2) (local.get $auto_i32_3))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 13: $th_or_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.or (call $get_reg (local.get $auto_i32_0)) (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF)))))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_1))
        (call $set_flags_logic (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 14: $th_adc_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (local.set $auto_i32_4 (i32.add (local.get $auto_i32_2) (call $get_cf)))
        (local.set $auto_i32_3 (i32.add (local.get $auto_i32_1) (local.get $auto_i32_4)))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_3))
        (call $set_flags_add (local.get $auto_i32_1) (local.get $auto_i32_4) (local.get $auto_i32_3))
        (if (i32.lt_u (local.get $auto_i32_4) (local.get $auto_i32_2)) (then (global.set $flag_op (i32.const 8)) (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 15: $th_sbb_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (local.set $auto_i32_4 (i32.add (local.get $auto_i32_2) (call $get_cf)))
        (local.set $auto_i32_3 (i32.sub (local.get $auto_i32_1) (local.get $auto_i32_4)))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_3))
        (call $set_flags_sub (local.get $auto_i32_1) (local.get $auto_i32_4) (local.get $auto_i32_3))
        (if (i32.lt_u (local.get $auto_i32_4) (local.get $auto_i32_2)) (then (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 16: $th_and_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (local.get $auto_i32_0)) (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF)))))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_1))
        (call $set_flags_logic (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 17: $th_sub_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (local.set $auto_i32_3 (i32.sub (local.get $auto_i32_1) (local.get $auto_i32_2)))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_3))
        (call $set_flags_sub (local.get $auto_i32_1) (local.get $auto_i32_2) (local.get $auto_i32_3))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 18: $th_xor_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.xor (call $get_reg (local.get $auto_i32_0)) (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF)))))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_1))
        (call $set_flags_logic (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 19: $th_cmp_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 2) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 7)) (i32.const 3)) (i32.and (local.get $auto_op) (i32.const 7)))) (call $branch_hist_set (i32.const 1) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 7)) (i32.const 3)) (i32.and (local.get $auto_op) (i32.const 7))))))
        (local.set $auto_i32_0 (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (local.set $auto_i32_1 (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 20: $th_load32
        (call $set_reg (local.get $auto_op) (call $gl32 (call $read_addr)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 21: $th_store32
        (call $gs32 (call $read_addr) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 22: $th_load16
        (call $set_reg16 (local.get $auto_op) (call $gl16 (call $read_addr)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 23: $th_store16
        (call $gs16 (call $read_addr) (call $get_reg16 (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 24: $th_load8
        (call $set_reg8 (local.get $auto_op) (call $gl8 (call $read_addr)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 25: $th_store8
        (call $gs8 (call $read_addr) (call $get_reg8 (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 26: $th_load32_ro
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $gl32 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 27: $th_store32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (local.get $auto_i32_0)) (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 28: $th_load8_ro
        (call $set_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $gl8 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 29: $th_store8_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs8 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (local.get $auto_i32_0)) (call $get_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 30: $th_load16_ro
        (call $set_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $gl16 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 31: $th_store16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs16 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (local.get $auto_i32_0)) (call $get_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 32: $th_push_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 33: $th_pop_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 34: $th_push_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 35: $th_pushad
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (global.get $esp))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 32)))
        (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (global.get $eax))
        (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (global.get $ecx))
        (call $gs32 (i32.add (global.get $esp) (i32.const 20)) (global.get $edx))
        (call $gs32 (i32.add (global.get $esp) (i32.const 16)) (global.get $ebx))
        (call $gs32 (i32.add (global.get $esp) (i32.const 12)) (local.get $auto_i32_0))
        (call $gs32 (i32.add (global.get $esp) (i32.const 8)) (global.get $ebp))
        (call $gs32 (i32.add (global.get $esp) (i32.const 4)) (global.get $esi))
        (call $gs32 (global.get $esp) (global.get $edi))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 36: $th_popad
        (global.set $edi (call $gl32 (global.get $esp)))
        (global.set $esi (call $gl32 (i32.add (global.get $esp) (i32.const 4))))
        (global.set $ebp (call $gl32 (i32.add (global.get $esp) (i32.const 8))))
        (global.set $ebx (call $gl32 (i32.add (global.get $esp) (i32.const 16))))
        (global.set $edx (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
        (global.set $ecx (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
        (global.set $eax (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
        (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 37: $th_pushfd
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (call $build_eflags))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 38: $th_popfd
        (call $load_eflags (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 39: $th_call_rel
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $auto_op))
        (call $cs_push (local.get $auto_op))
        (global.set $eip (local.get $auto_i32_0))
        (br $auto_done)
        ) ;; 40: $th_call_ind
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl32 (local.get $auto_i32_0)))
        (if (i32.and (i32.ge_u (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.lt_u (local.get $auto_i32_1) (global.get $thunk_guest_end))) (then (global.set $esp (i32.sub (global.get $esp) (i32.const 4))) (call $gs32 (global.get $esp) (local.get $auto_op)) (call $win32_dispatch (i32.div_u (i32.sub (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.const 8))) (if (global.get $steps) (then (global.set $eip (local.get $auto_op)))) (br $auto_done)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $auto_op))
        (call $cs_push (local.get $auto_op))
        (global.set $eip (local.get $auto_i32_1))
        (br $auto_done)
        ) ;; 41: $th_ret
        (global.set $eip (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (call $cs_pop)
        (br $auto_done)
        ) ;; 42: $th_ret_imm
        (global.set $eip (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.add (i32.const 4) (local.get $auto_op))))
        (call $cs_pop)
        (br $auto_done)
        ) ;; 43: $th_jmp
        (global.set $eip (call $read_thread_word))
        (br $auto_done)
        ) ;; 44: $th_jcc
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (local.get $auto_op))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (call $eval_cc (local.get $auto_op)))
        (if (local.get $auto_i32_2) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 45: $th_block_end
        (global.set $eip (local.get $auto_op))
        (br $auto_done)
        ) ;; 46: $th_loop
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_3 (i32.and (local.get $auto_op) (i32.const 0x3)))
        (if (i32.and (local.get $auto_op) (i32.const 0x10)) (then (local.set $auto_i32_4 (i32.and (i32.sub (i32.and (global.get $ecx) (i32.const 0xFFFF)) (i32.const 1)) (i32.const 0xFFFF))) (global.set $ecx (i32.or (i32.and (global.get $ecx) (i32.const 0xFFFF0000)) (local.get $auto_i32_4))) (local.set $auto_i32_2 (i32.ne (local.get $auto_i32_4) (i32.const 0)))) (else (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (local.set $auto_i32_2 (i32.ne (global.get $ecx) (i32.const 0)))))
        (if (i32.eq (local.get $auto_i32_3) (i32.const 1)) (then (local.set $auto_i32_2 (i32.and (local.get $auto_i32_2) (call $get_zf)))))
        (if (i32.eq (local.get $auto_i32_3) (i32.const 2)) (then (local.set $auto_i32_2 (i32.and (local.get $auto_i32_2) (i32.eqz (call $get_zf))))))
        (if (local.get $auto_i32_2) (then (global.set $eip (local.get $auto_i32_0))) (else (global.set $eip (local.get $auto_i32_1))))
        (br $auto_done)
        ) ;; 47: $th_alu_m32_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_2 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $gl32 (local.get $auto_i32_0)) (call $get_reg (local.get $auto_i32_2))))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 48: $th_alu_r_m32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_2 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $get_reg (local.get $auto_i32_2)) (call $gl32 (local.get $auto_i32_0))))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $set_reg (local.get $auto_i32_2) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 49: $th_alu_m8_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_2 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $gl8 (local.get $auto_i32_0)))
        (local.set $auto_i32_4 (call $get_reg8 (local.get $auto_i32_2)))
        (local.set $auto_i32_5 (call $do_alu32 (local.get $auto_i32_1) (local.get $auto_i32_3) (local.get $auto_i32_4)))
        (global.set $flag_sign_shift (i32.const 7))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $gs8 (local.get $auto_i32_0) (local.get $auto_i32_5))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 50: $th_alu_r_m8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_2 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $get_reg8 (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (call $gl8 (local.get $auto_i32_0)))
        (local.set $auto_i32_5 (call $do_alu32 (local.get $auto_i32_1) (local.get $auto_i32_3) (local.get $auto_i32_4)))
        (global.set $flag_sign_shift (i32.const 7))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $set_reg8 (local.get $auto_i32_2) (local.get $auto_i32_5))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 51: $th_alu_m32_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (call $do_alu32 (local.get $auto_op) (call $gl32 (local.get $auto_i32_0)) (local.get $auto_i32_1)))
        (if (i32.ne (local.get $auto_op) (i32.const 7)) (then (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 52: $th_alu_m8_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 0xFF)))
        (local.set $auto_i32_2 (call $do_alu32 (local.get $auto_op) (call $gl8 (local.get $auto_i32_0)) (local.get $auto_i32_1)))
        (global.set $flag_sign_shift (i32.const 7))
        (if (i32.ne (local.get $auto_op) (i32.const 7)) (then (call $gs8 (local.get $auto_i32_0) (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 53: $th_shift_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (local.get $auto_op) (i32.const 0xFF)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xFF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 16)) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 0xFF)) (then (local.set $auto_i32_2 (i32.and (global.get $ecx) (i32.const 31)))))
        (call $set_reg (local.get $auto_i32_0) (call $do_shift32 (local.get $auto_i32_1) (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 54: $th_shift_m32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xFF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 16)) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 0xFF)) (then (local.set $auto_i32_2 (i32.and (global.get $ecx) (i32.const 31)))))
        (call $gs32 (local.get $auto_i32_0) (call $do_shift32 (local.get $auto_i32_1) (call $gl32 (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 55: $th_mul32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_u (global.get $eax)) (i64.extend_i32_u (call $get_reg (local.get $auto_op)))))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_0)))
        (global.set $edx (i32.wrap_i64 (i64.shr_u (local.get $auto_i64_0) (i64.const 32))))
        (call $set_flags_mul (i32.ne (global.get $edx) (i32.const 0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 56: $th_imul32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (global.get $eax)) (i64.extend_i32_s (call $get_reg (local.get $auto_op)))))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_0)))
        (global.set $edx (i32.wrap_i64 (i64.shr_s (local.get $auto_i64_0) (i64.const 32))))
        (call $set_flags_mul (i32.ne (global.get $edx) (i32.shr_s (global.get $eax) (i32.const 31))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 57: $th_div32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i64_0 (i64.extend_i32_u (call $get_reg (local.get $auto_op))))
        (local.set $auto_i64_1 (i64.or (i64.extend_i32_u (global.get $eax)) (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
        (if (i64.eqz (local.get $auto_i64_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_2 (i64.div_u (local.get $auto_i64_1) (local.get $auto_i64_0)))
        (if (i64.gt_u (local.get $auto_i64_2) (i64.const 0xFFFFFFFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_2)))
        (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $auto_i64_1) (local.get $auto_i64_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 58: $th_idiv32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i64_0 (i64.extend_i32_s (call $get_reg (local.get $auto_op))))
        (local.set $auto_i64_1 (i64.or (i64.extend_i32_u (global.get $eax)) (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
        (if (i64.eqz (local.get $auto_i64_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_2 (i64.div_s (local.get $auto_i64_1) (local.get $auto_i64_0)))
        (if (i32.or (i64.gt_s (local.get $auto_i64_2) (i64.const 0x7FFFFFFF)) (i64.lt_s (local.get $auto_i64_2) (i64.const -2147483648))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_2)))
        (global.set $edx (i32.wrap_i64 (i64.rem_s (local.get $auto_i64_1) (local.get $auto_i64_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 59: $th_imul_r_r_i
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF)))) (i64.extend_i32_s (local.get $auto_i32_0))))
        (local.set $auto_i32_1 (i32.wrap_i64 (local.get $auto_i64_0)))
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1))
        (global.set $flag_op (i32.const 6))
        (global.set $flag_sign_shift (i32.const 31))
        (global.set $flag_b (i64.ne (local.get $auto_i64_0) (i64.extend_i32_s (local.get $auto_i32_1))))
        (global.set $flag_res (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 60: $th_mul_m32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_u (global.get $eax)) (i64.extend_i32_u (call $gl32 (local.get $auto_i32_0)))))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_0)))
        (global.set $edx (i32.wrap_i64 (i64.shr_u (local.get $auto_i64_0) (i64.const 32))))
        (call $set_flags_mul (i32.ne (global.get $edx) (i32.const 0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 61: $th_imul_m32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (global.get $eax)) (i64.extend_i32_s (call $gl32 (local.get $auto_i32_0)))))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_0)))
        (global.set $edx (i32.wrap_i64 (i64.shr_s (local.get $auto_i64_0) (i64.const 32))))
        (call $set_flags_mul (i32.ne (global.get $edx) (i32.shr_s (global.get $eax) (i32.const 31))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 62: $th_div_m32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i64_0 (i64.extend_i32_u (call $gl32 (local.get $auto_i32_0))))
        (local.set $auto_i64_1 (i64.or (i64.extend_i32_u (global.get $eax)) (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
        (if (i64.eqz (local.get $auto_i64_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_2 (i64.div_u (local.get $auto_i64_1) (local.get $auto_i64_0)))
        (if (i64.gt_u (local.get $auto_i64_2) (i64.const 0xFFFFFFFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_2)))
        (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $auto_i64_1) (local.get $auto_i64_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 63: $th_idiv_m32
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i64_0 (i64.extend_i32_s (call $gl32 (local.get $auto_i32_0))))
        (local.set $auto_i64_1 (i64.or (i64.extend_i32_u (global.get $eax)) (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32))))
        (if (i64.eqz (local.get $auto_i64_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_2 (i64.div_s (local.get $auto_i64_1) (local.get $auto_i64_0)))
        (if (i32.or (i64.gt_s (local.get $auto_i64_2) (i64.const 0x7FFFFFFF)) (i64.lt_s (local.get $auto_i64_2) (i64.const -2147483648))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.wrap_i64 (local.get $auto_i64_2)))
        (global.set $edx (i32.wrap_i64 (i64.rem_s (local.get $auto_i64_1) (local.get $auto_i64_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 64: $th_inc_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.add (local.get $auto_i32_0) (i32.const 1)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_1))
        (call $set_flags_inc (local.get $auto_i32_0) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 65: $th_dec_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.sub (local.get $auto_i32_0) (i32.const 1)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_1))
        (call $set_flags_dec (local.get $auto_i32_0) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 66: $th_not_r
        (call $set_reg (local.get $auto_op) (i32.xor (call $get_reg (local.get $auto_op)) (i32.const -1)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 67: $th_neg_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.sub (i32.const 0) (local.get $auto_i32_0)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_1))
        (call $set_flags_sub (i32.const 0) (local.get $auto_i32_0) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 68: $th_unary_m32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl32 (local.get $auto_i32_0)))
        (if (i32.eq (local.get $auto_op) (i32.const 0)) (then (local.set $auto_i32_2 (i32.add (local.get $auto_i32_1) (i32.const 1))) (call $set_flags_inc (local.get $auto_i32_1) (local.get $auto_i32_2))))
        (if (i32.eq (local.get $auto_op) (i32.const 1)) (then (local.set $auto_i32_2 (i32.sub (local.get $auto_i32_1) (i32.const 1))) (call $set_flags_dec (local.get $auto_i32_1) (local.get $auto_i32_2))))
        (if (i32.eq (local.get $auto_op) (i32.const 2)) (then (local.set $auto_i32_2 (i32.xor (local.get $auto_i32_1) (i32.const -1)))))
        (if (i32.eq (local.get $auto_op) (i32.const 3)) (then (local.set $auto_i32_2 (i32.sub (i32.const 0) (local.get $auto_i32_1))) (call $set_flags_sub (i32.const 0) (local.get $auto_i32_1) (local.get $auto_i32_2))))
        (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 69: $th_unary_m8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl8 (local.get $auto_i32_0)))
        (if (i32.eq (local.get $auto_op) (i32.const 0)) (then (local.set $auto_i32_2 (i32.and (i32.add (local.get $auto_i32_1) (i32.const 1)) (i32.const 0xFF))) (call $set_flags_inc (local.get $auto_i32_1) (local.get $auto_i32_2)) (global.set $flag_sign_shift (i32.const 7))))
        (if (i32.eq (local.get $auto_op) (i32.const 1)) (then (local.set $auto_i32_2 (i32.and (i32.sub (local.get $auto_i32_1) (i32.const 1)) (i32.const 0xFF))) (call $set_flags_dec (local.get $auto_i32_1) (local.get $auto_i32_2)) (global.set $flag_sign_shift (i32.const 7))))
        (if (i32.eq (local.get $auto_op) (i32.const 2)) (then (local.set $auto_i32_2 (i32.xor (local.get $auto_i32_1) (i32.const 0xFF)))))
        (if (i32.eq (local.get $auto_op) (i32.const 3)) (then (local.set $auto_i32_2 (i32.and (i32.sub (i32.const 0) (local.get $auto_i32_1)) (i32.const 0xFF))) (global.set $flag_op (i32.const 2)) (global.set $flag_sign_shift (i32.const 7)) (global.set $flag_a (i32.const 0)) (global.set $flag_b (local.get $auto_i32_1)) (global.set $flag_res (local.get $auto_i32_2))))
        (call $gs8 (local.get $auto_i32_0) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 70: $th_lea
        (call $set_reg (local.get $auto_op) (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 71: $th_xchg_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (if (i32.and (local.get $auto_op) (i32.const 0x100)) (then (local.set $auto_i32_2 (call $get_reg8 (local.get $auto_i32_0))) (local.set $auto_i32_3 (call $get_reg8 (local.get $auto_i32_1))) (call $set_reg8 (local.get $auto_i32_0) (local.get $auto_i32_3)) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_2))) (else (local.set $auto_i32_2 (call $get_reg (local.get $auto_i32_0))) (local.set $auto_i32_3 (call $get_reg (local.get $auto_i32_1))) (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_3)) (call $set_reg (local.get $auto_i32_1) (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 72: $th_test_r_r
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_set (i32.const 2) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 7)) (i32.const 3)) (i32.and (local.get $auto_op) (i32.const 7))))))
        (call $set_flags_logic (i32.and (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4))) (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 73: $th_test_r_i32
        (call $set_flags_logic (i32.and (call $get_reg (local.get $auto_op)) (call $read_thread_word)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 74: $th_test_m32_r
        (call $set_flags_logic (i32.and (call $gl32 (call $read_addr)) (call $get_reg (local.get $auto_op))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 75: $th_test_m32_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (call $set_flags_logic (i32.and (call $gl32 (local.get $auto_i32_0)) (call $read_thread_word)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 76: $th_mov_m32_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (call $gs32 (local.get $auto_i32_0) (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 77: $th_mov_m8_i8
        (call $gs8 (call $read_addr) (local.get $auto_op))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 78: $th_movzx8
        (call $set_reg (local.get $auto_op) (call $gl8 (call $read_addr)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 79: $th_movsx8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl8 (call $read_addr)))
        (if (i32.ge_u (local.get $auto_i32_0) (i32.const 0x80)) (then (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (i32.const 0xFFFFFF00)))))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 80: $th_movzx16
        (call $set_reg (local.get $auto_op) (call $gl16 (call $read_addr)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 81: $th_movsx16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (call $read_addr)))
        (if (i32.ge_u (local.get $auto_i32_0) (i32.const 0x8000)) (then (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (i32.const 0xFFFF0000)))))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 82: $th_rep_movsb
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (global.get $ecx))
        (if (local.get $auto_i32_0) (then (if (global.get $df) (then (local.set $auto_i32_1 (i32.sub (global.get $edi) (i32.sub (local.get $auto_i32_0) (i32.const 1)))) (local.set $auto_i32_2 (i32.sub (global.get $esi) (i32.sub (local.get $auto_i32_0) (i32.const 1)))) (call $invalidate_code_write (local.get $auto_i32_1)) (call $invalidate_code_write (global.get $edi)) (if (i32.and (i32.lt_u (local.get $auto_i32_1) (local.get $auto_i32_2)) (i32.lt_u (local.get $auto_i32_2) (i32.add (local.get $auto_i32_1) (local.get $auto_i32_0)))) (then (local.set $auto_i32_3 (i32.const 0)) (block $auto_h82_done (loop $auto_h82_copy (br_if $auto_h82_done (i32.ge_u (local.get $auto_i32_3) (local.get $auto_i32_0))) (call $gs8 (i32.sub (global.get $edi) (local.get $auto_i32_3)) (call $gl8 (i32.sub (global.get $esi) (local.get $auto_i32_3)))) (local.set $auto_i32_3 (i32.add (local.get $auto_i32_3) (i32.const 1))) (br $auto_h82_copy)))) (else (memory.copy (call $g2w (local.get $auto_i32_1)) (call $g2w (local.get $auto_i32_2)) (local.get $auto_i32_0)))) (global.set $esi (i32.sub (global.get $esi) (local.get $auto_i32_0))) (global.set $edi (i32.sub (global.get $edi) (local.get $auto_i32_0)))) (else (local.set $auto_i32_2 (global.get $esi)) (local.set $auto_i32_1 (global.get $edi)) (call $invalidate_code_write (global.get $edi)) (call $invalidate_code_write (i32.add (global.get $edi) (i32.sub (local.get $auto_i32_0) (i32.const 1)))) (if (i32.and (i32.lt_u (local.get $auto_i32_2) (local.get $auto_i32_1)) (i32.lt_u (local.get $auto_i32_1) (i32.add (local.get $auto_i32_2) (local.get $auto_i32_0)))) (then (local.set $auto_i32_3 (i32.const 0)) (block $auto_h82_done (loop $auto_h82_copy (br_if $auto_h82_done (i32.ge_u (local.get $auto_i32_3) (local.get $auto_i32_0))) (call $gs8 (i32.add (global.get $edi) (local.get $auto_i32_3)) (call $gl8 (i32.add (global.get $esi) (local.get $auto_i32_3)))) (local.set $auto_i32_3 (i32.add (local.get $auto_i32_3) (i32.const 1))) (br $auto_h82_copy)))) (else (memory.copy (call $g2w (global.get $edi)) (call $g2w (global.get $esi)) (local.get $auto_i32_0)))) (global.set $esi (i32.add (global.get $esi) (local.get $auto_i32_0))) (global.set $edi (i32.add (global.get $edi) (local.get $auto_i32_0))))) (global.set $ecx (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 83: $th_rep_movsd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (global.get $ecx))
        (if (local.get $auto_i32_0) (then (local.set $auto_i32_1 (i32.shl (local.get $auto_i32_0) (i32.const 2))) (if (global.get $df) (then (local.set $auto_i32_2 (i32.sub (global.get $edi) (i32.sub (local.get $auto_i32_1) (i32.const 4)))) (local.set $auto_i32_3 (i32.sub (global.get $esi) (i32.sub (local.get $auto_i32_1) (i32.const 4)))) (call $invalidate_code_write (local.get $auto_i32_2)) (call $invalidate_code_write (global.get $edi)) (if (i32.and (i32.lt_u (local.get $auto_i32_2) (local.get $auto_i32_3)) (i32.lt_u (local.get $auto_i32_3) (i32.add (local.get $auto_i32_2) (local.get $auto_i32_1)))) (then (local.set $auto_i32_4 (i32.const 0)) (block $auto_h83_done (loop $auto_h83_copy (br_if $auto_h83_done (i32.ge_u (local.get $auto_i32_4) (local.get $auto_i32_0))) (call $gs32 (i32.sub (global.get $edi) (i32.shl (local.get $auto_i32_4) (i32.const 2))) (call $gl32 (i32.sub (global.get $esi) (i32.shl (local.get $auto_i32_4) (i32.const 2))))) (local.set $auto_i32_4 (i32.add (local.get $auto_i32_4) (i32.const 1))) (br $auto_h83_copy)))) (else (memory.copy (call $g2w (local.get $auto_i32_2)) (call $g2w (local.get $auto_i32_3)) (local.get $auto_i32_1)))) (global.set $esi (i32.sub (global.get $esi) (local.get $auto_i32_1))) (global.set $edi (i32.sub (global.get $edi) (local.get $auto_i32_1)))) (else (local.set $auto_i32_3 (global.get $esi)) (local.set $auto_i32_2 (global.get $edi)) (call $invalidate_code_write (global.get $edi)) (call $invalidate_code_write (i32.add (global.get $edi) (i32.sub (local.get $auto_i32_1) (i32.const 1)))) (if (i32.and (i32.lt_u (local.get $auto_i32_3) (local.get $auto_i32_2)) (i32.lt_u (local.get $auto_i32_2) (i32.add (local.get $auto_i32_3) (local.get $auto_i32_1)))) (then (local.set $auto_i32_4 (i32.const 0)) (block $auto_h83_done (loop $auto_h83_copy (br_if $auto_h83_done (i32.ge_u (local.get $auto_i32_4) (local.get $auto_i32_0))) (call $gs32 (i32.add (global.get $edi) (i32.shl (local.get $auto_i32_4) (i32.const 2))) (call $gl32 (i32.add (global.get $esi) (i32.shl (local.get $auto_i32_4) (i32.const 2))))) (local.set $auto_i32_4 (i32.add (local.get $auto_i32_4) (i32.const 1))) (br $auto_h83_copy)))) (else (memory.copy (call $g2w (global.get $edi)) (call $g2w (global.get $esi)) (local.get $auto_i32_1)))) (global.set $esi (i32.add (global.get $esi) (local.get $auto_i32_1))) (global.set $edi (i32.add (global.get $edi) (local.get $auto_i32_1))))) (global.set $ecx (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 84: $th_rep_stosb
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (global.get $ecx))
        (if (local.get $auto_i32_0) (then (if (global.get $df) (then (local.set $auto_i32_1 (i32.sub (global.get $edi) (i32.sub (local.get $auto_i32_0) (i32.const 1)))) (call $invalidate_code_write (local.get $auto_i32_1)) (call $invalidate_code_write (global.get $edi)) (memory.fill (call $g2w (local.get $auto_i32_1)) (i32.and (global.get $eax) (i32.const 0xFF)) (local.get $auto_i32_0)) (global.set $edi (i32.sub (global.get $edi) (local.get $auto_i32_0)))) (else (call $invalidate_code_write (global.get $edi)) (call $invalidate_code_write (i32.add (global.get $edi) (i32.sub (local.get $auto_i32_0) (i32.const 1)))) (memory.fill (call $g2w (global.get $edi)) (i32.and (global.get $eax) (i32.const 0xFF)) (local.get $auto_i32_0)) (global.set $edi (i32.add (global.get $edi) (local.get $auto_i32_0))))) (global.set $ecx (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 85: $th_rep_stosd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (global.get $ecx))
        (if (local.get $auto_i32_0) (then (local.set $auto_i32_1 (i32.shl (local.get $auto_i32_0) (i32.const 2))) (local.set $auto_i32_2 (i32.and (global.get $eax) (i32.const 0xFF))) (if (i32.eq (global.get $eax) (i32.or (i32.shl (local.get $auto_i32_2) (i32.const 24)) (i32.or (i32.shl (local.get $auto_i32_2) (i32.const 16)) (i32.or (i32.shl (local.get $auto_i32_2) (i32.const 8)) (local.get $auto_i32_2))))) (then (if (global.get $df) (then (call $invalidate_code_write (i32.sub (global.get $edi) (i32.sub (local.get $auto_i32_1) (i32.const 4)))) (call $invalidate_code_write (global.get $edi)) (memory.fill (call $g2w (i32.sub (global.get $edi) (i32.sub (local.get $auto_i32_1) (i32.const 4)))) (local.get $auto_i32_2) (local.get $auto_i32_1)) (global.set $edi (i32.sub (global.get $edi) (local.get $auto_i32_1)))) (else (call $invalidate_code_write (global.get $edi)) (call $invalidate_code_write (i32.add (global.get $edi) (i32.sub (local.get $auto_i32_1) (i32.const 1)))) (memory.fill (call $g2w (global.get $edi)) (local.get $auto_i32_2) (local.get $auto_i32_1)) (global.set $edi (i32.add (global.get $edi) (local.get $auto_i32_1)))))) (else (block $auto_h85_d (loop $auto_h85_l (br_if $auto_h85_d (i32.eqz (local.get $auto_i32_0))) (call $gs32 (global.get $edi) (global.get $eax)) (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 4))))) (local.set $auto_i32_0 (i32.sub (local.get $auto_i32_0) (i32.const 1))) (br $auto_h85_l))))) (global.set $ecx (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 86: $th_movsb
        (call $gs8 (global.get $edi) (call $gl8 (global.get $esi)))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 87: $th_movsd
        (call $gs32 (global.get $edi) (call $gl32 (global.get $esi)))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4))) (global.set $edi (i32.sub (global.get $edi) (i32.const 4)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 4))) (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 88: $th_stosb
        (call $gs8 (global.get $edi) (i32.and (global.get $eax) (i32.const 0xFF)))
        (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 1)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 89: $th_stosd
        (call $gs32 (global.get $edi) (global.get $eax))
        (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 90: $th_lodsb
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFFFF00)) (call $gl8 (global.get $esi))))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 91: $th_lodsd
        (global.set $eax (call $gl32 (global.get $esi)))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 4)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 92: $th_rep_cmpsb
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (block $auto_h92_d (loop $auto_h92_l (br_if $auto_h92_d (i32.eqz (global.get $ecx))) (local.set $auto_i32_0 (call $gl8 (global.get $esi))) (local.set $auto_i32_1 (call $gl8 (global.get $edi))) (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1))) (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (if (i32.eqz (local.get $auto_op)) (then (br_if $auto_h92_d (i32.ne (local.get $auto_i32_0) (local.get $auto_i32_1)))) (else (br_if $auto_h92_d (i32.eq (local.get $auto_i32_0) (local.get $auto_i32_1))))) (br $auto_h92_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 93: $th_rep_scasb
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFF)))
        (block $auto_h93_d (loop $auto_h93_l (br_if $auto_h93_d (i32.eqz (global.get $ecx))) (local.set $auto_i32_1 (call $gl8 (global.get $edi))) (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1))) (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 1)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 1))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (if (i32.eqz (local.get $auto_op)) (then (br_if $auto_h93_d (i32.ne (local.get $auto_i32_0) (local.get $auto_i32_1)))) (else (br_if $auto_h93_d (i32.eq (local.get $auto_i32_0) (local.get $auto_i32_1))))) (br $auto_h93_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 94: $th_cmpsb
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $gl8 (global.get $esi)))
        (local.set $auto_i32_1 (call $gl8 (global.get $edi)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 1))) (global.set $edi (i32.sub (global.get $edi) (i32.const 1)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 1))) (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 95: $th_scasb
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFF)))
        (local.set $auto_i32_1 (call $gl8 (global.get $edi)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 1)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 96: $th_bt_r_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (global.set $flag_op (i32.const 2))
        (if (i32.and (i32.shr_u (call $get_reg (local.get $auto_op)) (local.get $auto_i32_0)) (i32.const 1)) (then (global.set $flag_a (i32.const 0)) (global.set $flag_b (i32.const 1))) (else (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0))))
        (global.set $flag_res (i32.const 0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 97: $th_bts_r_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_op)))
        (call $set_cf_bit (local.get $auto_i32_1) (local.get $auto_i32_0))
        (call $set_reg (local.get $auto_op) (i32.or (local.get $auto_i32_1) (i32.shl (i32.const 1) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 98: $th_btr_r_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_op)))
        (call $set_cf_bit (local.get $auto_i32_1) (local.get $auto_i32_0))
        (call $set_reg (local.get $auto_op) (i32.and (local.get $auto_i32_1) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_0)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 99: $th_btc_r_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_op)))
        (call $set_cf_bit (local.get $auto_i32_1) (local.get $auto_i32_0))
        (call $set_reg (local.get $auto_op) (i32.xor (local.get $auto_i32_1) (i32.shl (i32.const 1) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 100: $th_bsf
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 0)) (block $auto_h100_d (loop $auto_h100_l (br_if $auto_h100_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.add (local.get $auto_i32_1) (i32.const 1))) (br $auto_h100_l))) (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 101: $th_bsr
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 31)) (block $auto_h101_d (loop $auto_h101_l (br_if $auto_h101_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.sub (local.get $auto_i32_1) (i32.const 1))) (br $auto_h101_l))) (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 102: $th_setcc
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $set_reg8 (local.get $auto_i32_0) (call $eval_cc (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 103: $th_shld
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_3 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_3)))
        (local.set $auto_i32_2 (call $get_reg (local.get $auto_i32_4)))
        (if (local.get $auto_i32_0) (then (local.set $auto_i32_5 (i32.or (i32.shl (local.get $auto_i32_1) (local.get $auto_i32_0)) (i32.shr_u (local.get $auto_i32_2) (i32.sub (i32.const 32) (local.get $auto_i32_0))))) (call $set_reg (local.get $auto_i32_3) (local.get $auto_i32_5)) (call $set_flags_shift (local.get $auto_i32_5) (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.sub (i32.const 32) (local.get $auto_i32_0))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 104: $th_shrd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_3 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_3)))
        (local.set $auto_i32_2 (call $get_reg (local.get $auto_i32_4)))
        (if (local.get $auto_i32_0) (then (local.set $auto_i32_5 (i32.or (i32.shr_u (local.get $auto_i32_1) (local.get $auto_i32_0)) (i32.shl (local.get $auto_i32_2) (i32.sub (i32.const 32) (local.get $auto_i32_0))))) (call $set_reg (local.get $auto_i32_3) (local.get $auto_i32_5)) (call $set_flags_shift (local.get $auto_i32_5) (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (i32.const 1))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 105: $th_cdq
        (global.set $edx (i32.shr_s (global.get $eax) (i32.const 31)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 106: $th_cbw
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFF)))
        (if (i32.ge_u (local.get $auto_i32_0) (i32.const 0x80)) (then (call $set_reg16 (i32.const 0) (i32.or (local.get $auto_i32_0) (i32.const 0xFF00)))) (else (call $set_reg16 (i32.const 0) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 107: $th_cwde
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $auto_i32_0) (i32.const 0x8000)) (then (global.set $eax (i32.or (local.get $auto_i32_0) (i32.const 0xFFFF0000)))) (else (global.set $eax (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 108: $th_cld
        (global.set $df (i32.const 0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 109: $th_std
        (global.set $df (i32.const 1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 110: $th_clc
        (global.set $flag_op (i32.const 3))
        (global.set $flag_res (i32.const 0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 111: $th_stc
        (global.set $flag_op (i32.const 1))
        (global.set $flag_a (i32.const 0xFFFFFFFF))
        (global.set $flag_b (i32.const 1))
        (global.set $flag_res (i32.const 0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 112: $th_cmc
        (if (call $get_cf) (then (global.set $flag_op (i32.const 3)) (global.set $flag_res (i32.const 0))) (else (global.set $flag_op (i32.const 1)) (global.set $flag_a (i32.const 0xFFFFFFFF)) (global.set $flag_b (i32.const 1)) (global.set $flag_res (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 113: $th_leave
        (global.set $esp (global.get $ebp))
        (global.set $ebp (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 114: $th_nop2
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 115: $th_bswap
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (call $set_reg (local.get $auto_op) (i32.or (i32.or (i32.shl (i32.and (local.get $auto_i32_0) (i32.const 0xFF)) (i32.const 24)) (i32.shl (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 8)) (i32.const 0xFF)) (i32.const 16))) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 16)) (i32.const 0xFF)) (i32.const 8)) (i32.shr_u (local.get $auto_i32_0) (i32.const 24)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 116: $th_xchg_eax_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (global.get $eax))
        (global.set $eax (call $get_reg (local.get $auto_op)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 117: $th_thunk_call
        (call $win32_dispatch (local.get $auto_op))
        (br $auto_done)
        ) ;; 118: $th_imul_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (call $get_reg (local.get $auto_i32_0))) (i64.extend_i32_s (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))))
        (local.set $auto_i32_1 (i32.wrap_i64 (local.get $auto_i64_0)))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_1))
        (global.set $flag_op (i32.const 6))
        (global.set $flag_sign_shift (i32.const 31))
        (global.set $flag_b (i64.ne (local.get $auto_i64_0) (i64.extend_i32_s (local.get $auto_i32_1))))
        (global.set $flag_res (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 119: $th_call_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_0)))
        (if (i32.and (i32.ge_u (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.lt_u (local.get $auto_i32_1) (global.get $thunk_guest_end))) (then (global.set $esp (i32.sub (global.get $esp) (i32.const 4))) (call $gs32 (global.get $esp) (local.get $auto_op)) (call $win32_dispatch (i32.div_u (i32.sub (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.const 8))) (if (global.get $steps) (then (global.set $eip (local.get $auto_op)))) (br $auto_done)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $auto_op))
        (global.set $eip (local.get $auto_i32_1))
        (br $auto_done)
        ) ;; 120: $th_jmp_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (local.get $auto_op)))
        (if (i32.and (i32.ge_u (local.get $auto_i32_0) (global.get $thunk_guest_base)) (i32.lt_u (local.get $auto_i32_0) (global.get $thunk_guest_end))) (then (local.set $auto_i32_1 (call $gl32 (global.get $esp))) (call $win32_dispatch (i32.div_u (i32.sub (local.get $auto_i32_0) (global.get $thunk_guest_base)) (i32.const 8))) (if (global.get $steps) (then (global.set $eip (local.get $auto_i32_1)))) (br $auto_done)))
        (global.set $eip (local.get $auto_i32_0))
        (br $auto_done)
        ) ;; 121: $th_push_m32
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (call $gl32 (call $read_addr)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 122: $th_alu_m16_i16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (call $do_alu32 (local.get $auto_op) (call $gl16 (local.get $auto_i32_0)) (local.get $auto_i32_1)))
        (if (i32.ne (local.get $auto_op) (i32.const 7)) (then (call $gs16 (local.get $auto_i32_0) (local.get $auto_i32_2))))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 123: $th_load8s
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl8 (call $read_addr)))
        (if (i32.ge_u (local.get $auto_i32_0) (i32.const 0x80)) (then (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (i32.const 0xFFFFFF00)))))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 124: $th_test_m8_i8
        (call $set_flags_logic (i32.and (call $gl8 (call $read_addr)) (local.get $auto_op)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 125: $th_jmp_ind
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl32 (local.get $auto_i32_0)))
        (if (i32.and (i32.ge_u (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.lt_u (local.get $auto_i32_1) (global.get $thunk_guest_end))) (then (local.set $auto_i32_2 (call $gl32 (global.get $esp))) (call $win32_dispatch (i32.div_u (i32.sub (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.const 8))) (if (global.get $steps) (then (global.set $eip (local.get $auto_i32_2)))) (br $auto_done)))
        (global.set $eip (local.get $auto_i32_1))
        (br $auto_done)
        ) ;; 126: $th_lea_ro
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 127: $th_alu_m32_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $opform_hist_record (i32.const 2) (local.get $auto_op))))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $gl32 (local.get $auto_i32_0)) (call $get_reg (local.get $auto_i32_2))))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 128: $th_alu_r_m32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_set (i32.const 3) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 7)) (i32.const 6)) (i32.or (i32.shl (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 7)) (i32.const 3)) (i32.and (local.get $auto_op) (i32.const 7)))))))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $get_reg (local.get $auto_i32_2)) (call $gl32 (local.get $auto_i32_0))))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $set_reg (local.get $auto_i32_2) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 129: $th_alu_m8_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $opform_hist_record (i32.const 0) (local.get $auto_op))))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $gl8 (local.get $auto_i32_0)) (call $get_reg8 (local.get $auto_i32_2))))
        (global.set $flag_sign_shift (i32.const 7))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $gs8 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 130: $th_alu_r_m8_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $get_reg8 (local.get $auto_i32_2)) (call $gl8 (local.get $auto_i32_0))))
        (global.set $flag_sign_shift (i32.const 7))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $set_reg8 (local.get $auto_i32_2) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 131: $th_alu_m32_i_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $read_thread_word))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $gl32 (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 132: $th_alu_m8_i_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $read_thread_word))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $gl8 (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (global.set $flag_sign_shift (i32.const 7))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $gs8 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 133: $th_mov_m32_i32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (call $gs32 (local.get $auto_i32_0) (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 134: $th_mov_m8_i8_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (call $gs8 (local.get $auto_i32_0) (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 135: $th_unary_m32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 0)) (then (local.set $auto_i32_3 (i32.add (local.get $auto_i32_2) (i32.const 1))) (call $set_flags_inc (local.get $auto_i32_2) (local.get $auto_i32_3))))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 1)) (then (local.set $auto_i32_3 (i32.sub (local.get $auto_i32_2) (i32.const 1))) (call $set_flags_dec (local.get $auto_i32_2) (local.get $auto_i32_3))))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 2)) (then (local.set $auto_i32_3 (i32.xor (local.get $auto_i32_2) (i32.const -1)))))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 3)) (then (local.set $auto_i32_3 (i32.sub (i32.const 0) (local.get $auto_i32_2))) (call $set_flags_sub (i32.const 0) (local.get $auto_i32_2) (local.get $auto_i32_3))))
        (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_3))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 136: $th_test_m32_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $auto_i32_0)) (call $get_reg (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 137: $th_test_m32_i32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (drop (call $do_alu32 (i32.const 4) (call $gl32 (local.get $auto_i32_0)) (call $read_thread_word)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 138: $th_test_m8_i8_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (drop (call $do_alu32 (i32.const 4) (call $gl8 (local.get $auto_i32_0)) (call $read_thread_word)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 139: $th_shift_m32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.const 8)) (i32.const 7)))
        (local.set $auto_i32_3 (i32.and (local.get $auto_i32_1) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_3) (i32.const 0xFF)) (then (local.set $auto_i32_3 (i32.and (global.get $ecx) (i32.const 31)))))
        (local.set $auto_i32_4 (call $gl32 (local.get $auto_i32_0)))
        (call $gs32 (local.get $auto_i32_0) (call $do_shift32 (local.get $auto_i32_2) (local.get $auto_i32_4) (local.get $auto_i32_3)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 140: $th_call_ind_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (i32.add (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_1)))
        (local.set $auto_i32_3 (call $gl32 (local.get $auto_i32_2)))
        (if (i32.and (i32.ge_u (local.get $auto_i32_3) (global.get $thunk_guest_base)) (i32.lt_u (local.get $auto_i32_3) (global.get $thunk_guest_end))) (then (global.set $esp (i32.sub (global.get $esp) (i32.const 4))) (call $gs32 (global.get $esp) (local.get $auto_op)) (call $win32_dispatch (i32.div_u (i32.sub (local.get $auto_i32_3) (global.get $thunk_guest_base)) (i32.const 8))) (if (global.get $steps) (then (global.set $eip (local.get $auto_op)))) (br $auto_done)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $auto_op))
        (call $cs_push (local.get $auto_op))
        (global.set $eip (local.get $auto_i32_3))
        (br $auto_done)
        ) ;; 141: $th_jmp_ind_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (i32.add (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_1)))
        (local.set $auto_i32_3 (call $gl32 (local.get $auto_i32_2)))
        (if (i32.and (i32.ge_u (local.get $auto_i32_3) (global.get $thunk_guest_base)) (i32.lt_u (local.get $auto_i32_3) (global.get $thunk_guest_end))) (then (local.set $auto_i32_4 (call $gl32 (global.get $esp))) (call $win32_dispatch (i32.div_u (i32.sub (local.get $auto_i32_3) (global.get $thunk_guest_base)) (i32.const 8))) (if (global.get $steps) (then (global.set $eip (local.get $auto_i32_4)))) (br $auto_done)))
        (global.set $eip (local.get $auto_i32_3))
        (br $auto_done)
        ) ;; 142: $th_push_m32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (call $gl32 (local.get $auto_i32_0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 143: $th_movzx8_ro
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $gl8 (call $ea_from_op (local.get $auto_op))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 144: $th_movsx8_ro
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $sign_ext8 (call $gl8 (call $ea_from_op (local.get $auto_op)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 145: $th_movzx16_ro
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $gl16 (call $ea_from_op (local.get $auto_op))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 146: $th_movsx16_ro
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $sign_ext16 (call $gl16 (call $ea_from_op (local.get $auto_op)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 147: $th_muldiv_m32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 0)) (then (local.set $auto_i64_0 (i64.mul (i64.extend_i32_u (global.get $eax)) (i64.extend_i32_u (local.get $auto_i32_2)))) (global.set $eax (i32.wrap_i64 (local.get $auto_i64_0))) (global.set $edx (i32.wrap_i64 (i64.shr_u (local.get $auto_i64_0) (i64.const 32)))) (call $set_flags_mul (i32.ne (global.get $edx) (i32.const 0)))))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 1)) (then (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (global.get $eax)) (i64.extend_i32_s (local.get $auto_i32_2)))) (global.set $eax (i32.wrap_i64 (local.get $auto_i64_0))) (global.set $edx (i32.wrap_i64 (i64.shr_s (local.get $auto_i64_0) (i64.const 32)))) (call $set_flags_mul (i32.ne (global.get $edx) (i32.shr_s (global.get $eax) (i32.const 31))))))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 2)) (then (local.set $auto_i64_1 (i64.extend_i32_u (local.get $auto_i32_2))) (local.set $auto_i64_2 (i64.or (i64.extend_i32_u (global.get $eax)) (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32)))) (if (i64.eqz (local.get $auto_i64_1)) (then (call $raise_exception (i32.const 2)) (br $auto_done))) (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $auto_i64_2) (local.get $auto_i64_1)))) (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $auto_i64_2) (local.get $auto_i64_1))))))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 3)) (then (local.set $auto_i64_1 (i64.extend_i32_s (local.get $auto_i32_2))) (local.set $auto_i64_2 (i64.or (i64.extend_i32_u (global.get $eax)) (i64.shl (i64.extend_i32_u (global.get $edx)) (i64.const 32)))) (if (i64.eqz (local.get $auto_i64_1)) (then (call $raise_exception (i32.const 3)) (br $auto_done))) (global.set $eax (i32.wrap_i64 (i64.div_u (local.get $auto_i64_2) (local.get $auto_i64_1)))) (global.set $edx (i32.wrap_i64 (i64.rem_u (local.get $auto_i64_2) (local.get $auto_i64_1))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 148: $th_lea_sib
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_4 (call $read_thread_word))
        (if (i32.ne (i32.and (local.get $auto_i32_0) (i32.const 0xF)) (i32.const 0xF)) (then (local.set $auto_i32_1 (call $get_reg (i32.and (local.get $auto_i32_0) (i32.const 0xF))))))
        (if (i32.ne (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF)) (then (local.set $auto_i32_3 (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 8)) (i32.const 3))) (local.set $auto_i32_2 (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 4)) (i32.const 0xF))) (local.get $auto_i32_3)))))
        (call $set_reg (local.get $auto_op) (i32.add (i32.add (local.get $auto_i32_1) (local.get $auto_i32_2)) (local.get $auto_i32_4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 149: $th_compute_ea_sib
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_4 (call $read_thread_word))
        (if (global.get $handler_hist_enabled) (then (call $sib_consumer_hist_record (i32.load (global.get $ip)) (i32.load offset=4 (global.get $ip)) (local.get $auto_i32_0))))
        (if (i32.ne (i32.and (local.get $auto_i32_0) (i32.const 0xF)) (i32.const 0xF)) (then (local.set $auto_i32_1 (call $get_reg (i32.and (local.get $auto_i32_0) (i32.const 0xF))))))
        (if (i32.ne (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 4)) (i32.const 0xF)) (i32.const 0xF)) (then (local.set $auto_i32_3 (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 8)) (i32.const 3))) (local.set $auto_i32_2 (i32.shl (call $get_reg (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 4)) (i32.const 0xF))) (local.get $auto_i32_3)))))
        (global.set $ea_temp (i32.add (i32.add (local.get $auto_i32_1) (local.get $auto_i32_2)) (local.get $auto_i32_4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 150: $th_test_r8_r8
        (call $set_flags_logic (i32.and (call $get_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4))) (call $get_reg8 (i32.and (local.get $auto_op) (i32.const 0xF)))))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 151: $th_test_m8_r
        (call $set_flags_logic (i32.and (call $gl8 (call $read_addr)) (call $get_reg8 (local.get $auto_op))))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 152: $th_test_m8_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word)))
        (call $set_flags_logic (i32.and (call $gl8 (local.get $auto_i32_0)) (call $get_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4)))))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 153: $th_alu_r8_r8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_6 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $opform_hist_record (i32.const 1) (local.get $auto_op))))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 8)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_3 (call $get_reg8 (local.get $auto_i32_1)))
        (local.set $auto_i32_4 (call $get_reg8 (local.get $auto_i32_2)))
        (block $auto_h153_done (block $auto_h153_cmp (block $auto_h153_xor (block $auto_h153_sub (block $auto_h153_and (block $auto_h153_sbb (block $auto_h153_adc (block $auto_h153_or (block $auto_h153_add (br_table $auto_h153_add $auto_h153_or $auto_h153_adc $auto_h153_sbb $auto_h153_and $auto_h153_sub $auto_h153_xor $auto_h153_cmp (local.get $auto_i32_0))) (local.set $auto_i32_5 (i32.and (i32.add (local.get $auto_i32_3) (local.get $auto_i32_4)) (i32.const 0xFF))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_5)) (call $set_flags_add (local.get $auto_i32_3) (local.get $auto_i32_4) (local.get $auto_i32_5)) (br $auto_h153_done)) (local.set $auto_i32_5 (i32.or (local.get $auto_i32_3) (local.get $auto_i32_4))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_5)) (call $set_flags_logic (local.get $auto_i32_5)) (br $auto_h153_done)) (local.set $auto_i32_6 (call $get_cf)) (local.set $auto_i32_5 (i32.add (i32.add (local.get $auto_i32_3) (local.get $auto_i32_4)) (local.get $auto_i32_6))) (call $set_reg8 (local.get $auto_i32_1) (i32.and (local.get $auto_i32_5) (i32.const 0xFF))) (call $set_flags_add (local.get $auto_i32_3) (i32.add (local.get $auto_i32_4) (local.get $auto_i32_6)) (i32.and (local.get $auto_i32_5) (i32.const 0xFF))) (if (i32.ge_u (local.get $auto_i32_5) (i32.const 0x100)) (then (global.set $flag_op (i32.const 8)) (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0)))) (br $auto_h153_done)) (local.set $auto_i32_6 (call $get_cf)) (local.set $auto_i32_5 (i32.sub (i32.sub (local.get $auto_i32_3) (local.get $auto_i32_4)) (local.get $auto_i32_6))) (call $set_reg8 (local.get $auto_i32_1) (i32.and (local.get $auto_i32_5) (i32.const 0xFF))) (call $set_flags_sub (local.get $auto_i32_3) (i32.add (local.get $auto_i32_4) (local.get $auto_i32_6)) (i32.and (local.get $auto_i32_5) (i32.const 0xFF))) (if (i32.and (local.get $auto_i32_5) (i32.const 0xFFFFFF00)) (then (global.set $flag_op (i32.const 8)) (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0)))) (br $auto_h153_done)) (local.set $auto_i32_5 (i32.and (local.get $auto_i32_3) (local.get $auto_i32_4))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_5)) (call $set_flags_logic (local.get $auto_i32_5)) (br $auto_h153_done)) (local.set $auto_i32_5 (i32.and (i32.sub (local.get $auto_i32_3) (local.get $auto_i32_4)) (i32.const 0xFF))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_5)) (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_4) (local.get $auto_i32_5)) (br $auto_h153_done)) (local.set $auto_i32_5 (i32.xor (local.get $auto_i32_3) (local.get $auto_i32_4))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_5)) (call $set_flags_logic (local.get $auto_i32_5)) (br $auto_h153_done)) (local.set $auto_i32_5 (i32.and (i32.sub (local.get $auto_i32_3) (local.get $auto_i32_4)) (i32.const 0xFF))) (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_4) (local.get $auto_i32_5)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 154: $th_alu_r8_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 8)))
        (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $get_reg8 (local.get $auto_i32_1)))
        (local.set $auto_i32_3 (i32.and (call $read_thread_word) (i32.const 0xFF)))
        (block $auto_h154_done (block $auto_h154_cmp (block $auto_h154_xor (block $auto_h154_sub (block $auto_h154_and (block $auto_h154_sbb (block $auto_h154_adc (block $auto_h154_or (block $auto_h154_add (br_table $auto_h154_add $auto_h154_or $auto_h154_adc $auto_h154_sbb $auto_h154_and $auto_h154_sub $auto_h154_xor $auto_h154_cmp (local.get $auto_i32_0))) (local.set $auto_i32_4 (i32.and (i32.add (local.get $auto_i32_2) (local.get $auto_i32_3)) (i32.const 0xFF))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_4)) (call $set_flags_add (local.get $auto_i32_2) (local.get $auto_i32_3) (local.get $auto_i32_4)) (br $auto_h154_done)) (local.set $auto_i32_4 (i32.or (local.get $auto_i32_2) (local.get $auto_i32_3))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_4)) (call $set_flags_logic (local.get $auto_i32_4)) (br $auto_h154_done)) (local.set $auto_i32_5 (call $get_cf)) (local.set $auto_i32_4 (i32.add (i32.add (local.get $auto_i32_2) (local.get $auto_i32_3)) (local.get $auto_i32_5))) (call $set_reg8 (local.get $auto_i32_1) (i32.and (local.get $auto_i32_4) (i32.const 0xFF))) (call $set_flags_add (local.get $auto_i32_2) (i32.add (local.get $auto_i32_3) (local.get $auto_i32_5)) (i32.and (local.get $auto_i32_4) (i32.const 0xFF))) (if (i32.ge_u (local.get $auto_i32_4) (i32.const 0x100)) (then (global.set $flag_op (i32.const 8)) (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0)))) (br $auto_h154_done)) (local.set $auto_i32_5 (call $get_cf)) (local.set $auto_i32_4 (i32.sub (i32.sub (local.get $auto_i32_2) (local.get $auto_i32_3)) (local.get $auto_i32_5))) (call $set_reg8 (local.get $auto_i32_1) (i32.and (local.get $auto_i32_4) (i32.const 0xFF))) (call $set_flags_sub (local.get $auto_i32_2) (i32.add (local.get $auto_i32_3) (local.get $auto_i32_5)) (i32.and (local.get $auto_i32_4) (i32.const 0xFF))) (if (i32.and (local.get $auto_i32_4) (i32.const 0xFFFFFF00)) (then (global.set $flag_op (i32.const 8)) (global.set $flag_a (i32.const 1)) (global.set $flag_b (i32.const 0)))) (br $auto_h154_done)) (local.set $auto_i32_4 (i32.and (local.get $auto_i32_2) (local.get $auto_i32_3))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_4)) (call $set_flags_logic (local.get $auto_i32_4)) (br $auto_h154_done)) (local.set $auto_i32_4 (i32.and (i32.sub (local.get $auto_i32_2) (local.get $auto_i32_3)) (i32.const 0xFF))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_4)) (call $set_flags_sub (local.get $auto_i32_2) (local.get $auto_i32_3) (local.get $auto_i32_4)) (br $auto_h154_done)) (local.set $auto_i32_4 (i32.xor (local.get $auto_i32_2) (local.get $auto_i32_3))) (call $set_reg8 (local.get $auto_i32_1) (local.get $auto_i32_4)) (call $set_flags_logic (local.get $auto_i32_4)) (br $auto_h154_done)) (local.set $auto_i32_4 (i32.and (i32.sub (local.get $auto_i32_2) (local.get $auto_i32_3)) (i32.const 0xFF))) (call $set_flags_sub (local.get $auto_i32_2) (local.get $auto_i32_3) (local.get $auto_i32_4)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 155: $th_mov_r8_r8
        (call $set_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $get_reg8 (i32.and (local.get $auto_op) (i32.const 0xF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 156: $th_mov_r8_i8
        (call $set_reg8 (local.get $auto_op) (i32.and (call $read_thread_word) (i32.const 0xFF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 157: $th_imul_r_m_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (call $get_reg (local.get $auto_i32_1))) (i64.extend_i32_s (call $gl32 (local.get $auto_i32_0)))))
        (local.set $auto_i32_2 (i32.wrap_i64 (local.get $auto_i64_0)))
        (call $set_reg (local.get $auto_i32_1) (local.get $auto_i32_2))
        (global.set $flag_op (i32.const 6))
        (global.set $flag_sign_shift (i32.const 31))
        (global.set $flag_b (i64.ne (local.get $auto_i64_0) (i64.extend_i32_s (local.get $auto_i32_2))))
        (global.set $flag_res (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 158: $th_imul_r_m_abs
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (call $get_reg (local.get $auto_op))) (i64.extend_i32_s (call $gl32 (local.get $auto_i32_0)))))
        (local.set $auto_i32_1 (i32.wrap_i64 (local.get $auto_i64_0)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_1))
        (global.set $flag_op (i32.const 6))
        (global.set $flag_sign_shift (i32.const 31))
        (global.set $flag_b (i64.ne (local.get $auto_i64_0) (i64.extend_i32_s (local.get $auto_i32_1))))
        (global.set $flag_res (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 159: $th_alu_r16_m16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0x7)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_2) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)) (call $gl16 (local.get $auto_i32_0))))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (if (i32.ne (local.get $auto_i32_2) (i32.const 7)) (then (call $set_reg (local.get $auto_i32_1) (i32.or (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 160: $th_alu_m16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0x7)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_2) (call $gl16 (local.get $auto_i32_0)) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF))))
        (if (i32.ne (local.get $auto_i32_2) (i32.const 7)) (then (call $gs16 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 161: $th_alu_r16_m16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0x7)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_2) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)) (call $gl16 (local.get $auto_i32_0))))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (if (i32.ne (local.get $auto_i32_2) (i32.const 7)) (then (call $set_reg (local.get $auto_i32_1) (i32.or (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 162: $th_alu_m16_r16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0x7)))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_2) (call $gl16 (local.get $auto_i32_0)) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF))))
        (if (i32.ne (local.get $auto_i32_2) (i32.const 7)) (then (call $gs16 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 163: $th_mov_m16_r16
        (call $gs16 (call $read_addr) (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 164: $th_mov_r16_m16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (call $read_addr)))
        (call $set_reg (local.get $auto_op) (i32.or (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF0000)) (local.get $auto_i32_0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 165: $th_mov_m16_r16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (call $gs16 (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 166: $th_mov_r16_m16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $gl16 (local.get $auto_i32_0)))
        (call $set_reg (local.get $auto_i32_1) (i32.or (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF0000)) (local.get $auto_i32_2)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 167: $th_mov_m16_i16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (call $gs16 (local.get $auto_i32_0) (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 168: $th_mov_m16_i16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.add (call $get_reg (local.get $auto_op)) (call $read_thread_word)))
        (call $gs16 (local.get $auto_i32_0) (call $read_thread_word))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 169: $th_rep_cmpsd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (block $auto_h169_d (loop $auto_h169_l (br_if $auto_h169_d (i32.eqz (global.get $ecx))) (local.set $auto_i32_0 (call $gl32 (global.get $esi))) (local.set $auto_i32_1 (call $gl32 (global.get $edi))) (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1))) (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4))) (global.set $edi (i32.sub (global.get $edi) (i32.const 4)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 4))) (global.set $edi (i32.add (global.get $edi) (i32.const 4))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (if (i32.eqz (local.get $auto_op)) (then (br_if $auto_h169_d (i32.ne (local.get $auto_i32_0) (local.get $auto_i32_1)))) (else (br_if $auto_h169_d (i32.eq (local.get $auto_i32_0) (local.get $auto_i32_1))))) (br $auto_h169_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 170: $th_rep_scasd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (global.get $eax))
        (block $auto_h170_d (loop $auto_h170_l (br_if $auto_h170_d (i32.eqz (global.get $ecx))) (local.set $auto_i32_1 (call $gl32 (global.get $edi))) (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1))) (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 4))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (if (i32.eqz (local.get $auto_op)) (then (br_if $auto_h170_d (i32.ne (local.get $auto_i32_0) (local.get $auto_i32_1)))) (else (br_if $auto_h170_d (i32.eq (local.get $auto_i32_0) (local.get $auto_i32_1))))) (br $auto_h170_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 171: $th_cmpsd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $gl32 (global.get $esi)))
        (local.set $auto_i32_1 (call $gl32 (global.get $edi)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 4))) (global.set $edi (i32.sub (global.get $edi) (i32.const 4)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 4))) (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 172: $th_scasd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (global.get $eax))
        (local.set $auto_i32_1 (call $gl32 (global.get $edi)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 4)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 4)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 173: $th_cmpxchg
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (if (i32.ge_u (local.get $auto_op) (i32.const 0x80)) (then (local.set $auto_op (i32.and (local.get $auto_op) (i32.const 0x7F))) (local.set $auto_i32_0 (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4)))) (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF))) (if (i32.eq (global.get $eax) (local.get $auto_i32_0)) (then (call $set_flags_sub (global.get $eax) (local.get $auto_i32_0) (i32.const 0)) (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $get_reg (local.get $auto_i32_1)))) (else (call $set_flags_sub (global.get $eax) (local.get $auto_i32_0) (i32.sub (global.get $eax) (local.get $auto_i32_0))) (global.set $eax (local.get $auto_i32_0))))) (else (local.set $auto_i32_1 (local.get $auto_op)) (local.set $auto_i32_2 (call $read_addr)) (local.set $auto_i32_0 (call $gl32 (local.get $auto_i32_2))) (if (i32.eq (global.get $eax) (local.get $auto_i32_0)) (then (call $set_flags_sub (global.get $eax) (local.get $auto_i32_0) (i32.const 0)) (call $gs32 (local.get $auto_i32_2) (call $get_reg (local.get $auto_i32_1)))) (else (call $set_flags_sub (global.get $eax) (local.get $auto_i32_0) (i32.sub (global.get $eax) (local.get $auto_i32_0))) (global.set $eax (local.get $auto_i32_0))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 174: $th_xadd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (if (i32.ge_u (local.get $auto_op) (i32.const 0x80)) (then (local.set $auto_op (i32.and (local.get $auto_op) (i32.const 0x7F))) (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF))) (local.set $auto_i32_0 (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4)))) (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (call $get_reg (local.get $auto_i32_1)))) (call $set_flags_add (local.get $auto_i32_0) (call $get_reg (local.get $auto_i32_1)) (local.get $auto_i32_2)) (call $set_reg (local.get $auto_i32_1) (local.get $auto_i32_0)) (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_2))) (else (local.set $auto_i32_1 (local.get $auto_op)) (local.set $auto_i32_3 (call $read_addr)) (local.set $auto_i32_0 (call $gl32 (local.get $auto_i32_3))) (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (call $get_reg (local.get $auto_i32_1)))) (call $set_flags_add (local.get $auto_i32_0) (call $get_reg (local.get $auto_i32_1)) (local.get $auto_i32_2)) (call $set_reg (local.get $auto_i32_1) (local.get $auto_i32_0)) (call $gs32 (local.get $auto_i32_3) (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 175: $th_cpuid
        (if (i32.eqz (global.get $eax)) (then (global.set $eax (i32.const 1)) (global.set $ebx (i32.const 0x756E6547)) (global.set $edx (i32.const 0x49656E69)) (global.set $ecx (i32.const 0x6C65746E))) (else (if (i32.eq (global.get $eax) (i32.const 1)) (then (global.set $eax (i32.const 0x00000480)) (global.set $ebx (i32.const 0)) (global.set $ecx (i32.const 0)) (global.set $edx (i32.const 0x00000001))) (else (global.set $eax (i32.const 0)) (global.set $ebx (i32.const 0)) (global.set $ecx (i32.const 0)) (global.set $edx (i32.const 0))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 176: $th_bt_m_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (call $set_cf_bit (local.get $auto_i32_2) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 177: $th_bts_m_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (call $set_cf_bit (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $gs32 (local.get $auto_i32_0) (i32.or (local.get $auto_i32_2) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 178: $th_btr_m_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (call $set_cf_bit (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $gs32 (local.get $auto_i32_0) (i32.and (local.get $auto_i32_2) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_1)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 179: $th_btc_m_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (call $set_cf_bit (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $gs32 (local.get $auto_i32_0) (i32.xor (local.get $auto_i32_2) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 180: $th_cwd
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $auto_i32_0) (i32.const 0x8000)) (then (call $set_reg16 (i32.const 2) (i32.const 0xFFFF))) (else (call $set_reg16 (i32.const 2) (i32.const 0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 181: $th_push_r16
        (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
        (call $gs16 (global.get $esp) (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 182: $th_pop_r16
        (call $set_reg16 (local.get $auto_op) (call $gl16 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 183: $th_movsw
        (call $gs16 (global.get $edi) (call $gl16 (global.get $esi)))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2))) (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 2))) (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 184: $th_stosw
        (call $gs16 (global.get $edi) (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 185: $th_lodsw
        (call $set_reg16 (i32.const 0) (call $gl16 (global.get $esi)))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 2)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 186: $th_rep_movsw
        (block $auto_h186_d (loop $auto_h186_l (br_if $auto_h186_d (i32.eqz (global.get $ecx))) (call $gs16 (global.get $edi) (call $gl16 (global.get $esi))) (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2))) (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 2))) (global.set $edi (i32.add (global.get $edi) (i32.const 2))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (br $auto_h186_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 187: $th_rep_stosw
        (block $auto_h187_d (loop $auto_h187_l (br_if $auto_h187_d (i32.eqz (global.get $ecx))) (call $gs16 (global.get $edi) (i32.and (global.get $eax) (i32.const 0xFFFF))) (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 2))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (br $auto_h187_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 188: $th_fpu_mem
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (if (i32.eq (local.get $auto_i32_0) (global.get $SIB_SENTINEL)) (then (local.set $auto_i32_0 (global.get $ea_temp))))
        (call $fpu_exec_mem (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.and (local.get $auto_op) (i32.const 0xF)) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 189: $th_fpu_reg
        (call $fpu_exec_reg (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)) (i32.and (local.get $auto_op) (i32.const 0xF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 190: $th_fpu_mem_ro
        (call $fpu_exec_mem (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)) (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 191: $th_shift_r8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (local.get $auto_op) (i32.const 0xFF)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xFF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 16)) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 0xFF)) (then (local.set $auto_i32_2 (i32.and (global.get $ecx) (i32.const 31)))))
        (call $set_reg8 (local.get $auto_i32_0) (call $do_shift8 (local.get $auto_i32_1) (call $get_reg8 (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 192: $th_shift_m8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xFF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 16)) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 0xFF)) (then (local.set $auto_i32_2 (i32.and (global.get $ecx) (i32.const 31)))))
        (call $gs8 (local.get $auto_i32_0) (call $do_shift8 (local.get $auto_i32_1) (call $gl8 (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 193: $th_shift_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (local.get $auto_op) (i32.const 0xFF)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xFF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 16)) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 0xFF)) (then (local.set $auto_i32_2 (i32.and (global.get $ecx) (i32.const 31)))))
        (local.set $auto_i32_3 (call $do_shift16 (local.get $auto_i32_1) (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (call $set_reg (local.get $auto_i32_0) (i32.or (i32.and (call $get_reg (local.get $auto_i32_0)) (i32.const 0xFFFF0000)) (local.get $auto_i32_3)))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 194: $th_shift_m16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xFF)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 16)) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 0xFF)) (then (local.set $auto_i32_2 (i32.and (global.get $ecx) (i32.const 31)))))
        (call $gs16 (local.get $auto_i32_0) (call $do_shift16 (local.get $auto_i32_1) (call $gl16 (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 195: $th_cmpxchg8b
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl32 (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (call $gl32 (i32.add (local.get $auto_i32_0) (i32.const 4))))
        (if (i32.and (i32.eq (global.get $eax) (local.get $auto_i32_1)) (i32.eq (global.get $edx) (local.get $auto_i32_2))) (then (call $set_flags_logic (i32.const 0)) (call $gs32 (local.get $auto_i32_0) (global.get $ebx)) (call $gs32 (i32.add (local.get $auto_i32_0) (i32.const 4)) (global.get $ecx))) (else (call $set_flags_logic (i32.const 1)) (global.set $eax (local.get $auto_i32_1)) (global.set $edx (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 196: $th_xchg_m_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl32 (local.get $auto_i32_0)))
        (call $gs32 (local.get $auto_i32_0) (call $get_reg (local.get $auto_op)))
        (call $set_reg (local.get $auto_op) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 197: $th_xchg_m_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word)))
        (local.set $auto_i32_1 (call $gl32 (local.get $auto_i32_0)))
        (call $gs32 (local.get $auto_i32_0) (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 198: $th_bt_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 31)))
        (call $set_cf_bit (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 199: $th_bts_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 31)))
        (call $set_cf_bit (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_1))
        (call $set_reg (local.get $auto_i32_0) (i32.or (call $get_reg (local.get $auto_i32_0)) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 200: $th_btr_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 31)))
        (call $set_cf_bit (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_1))
        (call $set_reg (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_0)) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_1)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 201: $th_btc_r_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 31)))
        (call $set_cf_bit (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_1))
        (call $set_reg (local.get $auto_i32_0) (i32.xor (call $get_reg (local.get $auto_i32_0)) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 202: $th_inc_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (local.set $auto_i32_1 (i32.and (i32.add (local.get $auto_i32_0) (i32.const 1)) (i32.const 0xFFFF)))
        (call $set_reg (local.get $auto_op) (i32.or (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF0000)) (local.get $auto_i32_1)))
        (call $set_flags_inc (local.get $auto_i32_0) (local.get $auto_i32_1))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 203: $th_dec_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (local.set $auto_i32_1 (i32.and (i32.sub (local.get $auto_i32_0) (i32.const 1)) (i32.const 0xFFFF)))
        (call $set_reg (local.get $auto_op) (i32.or (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF0000)) (local.get $auto_i32_1)))
        (call $set_flags_dec (local.get $auto_i32_0) (local.get $auto_i32_1))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 204: $th_test_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (i32.and (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4))) (i32.const 0xFFFF)) (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 0xFFFF))))
        (call $set_flags_logic (local.get $auto_i32_0))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 205: $th_test_ax_i16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (i32.and (global.get $eax) (i32.const 0xFFFF)) (call $read_thread_word)))
        (call $set_flags_logic (local.get $auto_i32_0))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 206: $th_alu_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 7)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $do_alu32 (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)) (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 0xFFFF))))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (if (i32.ne (local.get $auto_i32_0) (i32.const 7)) (then (call $set_reg16 (local.get $auto_i32_1) (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 207: $th_alu_r16_i16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 7)))
        (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $do_alu32 (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)) (call $read_thread_word)))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (if (i32.ne (local.get $auto_i32_0) (i32.const 7)) (then (call $set_reg16 (local.get $auto_i32_1) (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 208: $th_movzx_r_r8
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $get_reg8 (i32.and (local.get $auto_op) (i32.const 0xF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 209: $th_movsx_r_r8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg8 (i32.and (local.get $auto_op) (i32.const 0xF))))
        (if (i32.and (local.get $auto_i32_0) (i32.const 0x80)) (then (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (i32.const 0xFFFFFF00)))))
        (call $set_reg (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 210: $th_mov_r16_r16
        (call $set_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 0xFFFF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 211: $th_setcc_mem
        (call $gs8 (call $read_addr) (call $eval_cc (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 212: $th_sahf
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_1 (call $get_of))
        (local.set $auto_i32_0 (i32.and (i32.shr_u (global.get $eax) (i32.const 8)) (i32.const 0xFF)))
        (global.set $flag_op (i32.const 8))
        (global.set $flag_sign_shift (i32.const 31))
        (global.set $flag_a (i32.and (local.get $auto_i32_0) (i32.const 1)))
        (global.set $flag_b (local.get $auto_i32_1))
        (if (i32.and (local.get $auto_i32_0) (i32.const 0x40)) (then (global.set $flag_res (i32.const 0))) (else (if (i32.and (local.get $auto_i32_0) (i32.const 0x80)) (then (global.set $flag_res (i32.const 0x80000000))) (else (global.set $flag_res (i32.const 1))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 213: $th_lahf
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.const 0x02))
        (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (call $get_cf)))
        (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (i32.shl (call $get_zf) (i32.const 6))))
        (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (i32.shl (call $get_sf) (i32.const 7))))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF00FF)) (i32.shl (local.get $auto_i32_0) (i32.const 8))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 214: $th_neg_r8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg8 (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.sub (i32.const 0) (local.get $auto_i32_0)) (i32.const 0xFF)))
        (call $set_reg8 (local.get $auto_op) (local.get $auto_i32_1))
        (global.set $flag_op (i32.const 2))
        (global.set $flag_sign_shift (i32.const 7))
        (global.set $flag_a (i32.const 0))
        (global.set $flag_b (local.get $auto_i32_0))
        (global.set $flag_res (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 215: $th_not_r8
        (call $set_reg8 (local.get $auto_op) (i32.xor (call $get_reg8 (local.get $auto_op)) (i32.const 0xFF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 216: $th_jecxz
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.and (local.get $auto_op) (i32.const 1)) (then (local.set $auto_i32_2 (i32.eqz (i32.and (global.get $ecx) (i32.const 0xFFFF))))) (else (local.set $auto_i32_2 (i32.eqz (global.get $ecx)))))
        (if (local.get $auto_i32_2) (then (global.set $eip (local.get $auto_i32_0))) (else (global.set $eip (local.get $auto_i32_1))))
        (br $auto_done)
        ) ;; 217: $th_test_r8_i
        (call $set_flags_logic (i32.and (call $get_reg8 (local.get $auto_op)) (call $read_thread_word)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 218: $th_setcc_mem_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs8 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (local.get $auto_i32_0)) (call $eval_cc (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 219: $th_xchg_r8_r8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (local.set $auto_i32_1 (call $get_reg8 (i32.and (local.get $auto_op) (i32.const 0xF))))
        (call $set_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1))
        (call $set_reg8 (i32.and (local.get $auto_op) (i32.const 0xF)) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 220: $th_alu_m16_i_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 8)) (i32.const 0xF)))
        (local.set $auto_i32_2 (call $read_thread_word))
        (local.set $auto_i32_3 (call $do_alu32 (local.get $auto_i32_1) (call $gl16 (local.get $auto_i32_0)) (local.get $auto_i32_2)))
        (if (i32.ne (local.get $auto_i32_1) (i32.const 7)) (then (call $gs16 (local.get $auto_i32_0) (local.get $auto_i32_3))))
        (global.set $flag_res (i32.and (global.get $flag_res) (i32.const 0xFFFF)))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 221: $th_cmovcc_rr
        (if (call $eval_cc (i32.shr_u (local.get $auto_op) (i32.const 8))) (then (call $set_reg (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)) (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 222: $th_cmovcc_rm
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl32 (call $read_addr)))
        (if (call $eval_cc (i32.shr_u (local.get $auto_op) (i32.const 4))) (then (call $set_reg (i32.and (local.get $auto_op) (i32.const 0xF)) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 223: $th_shld_m
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (local.set $auto_i32_3 (call $get_reg (local.get $auto_op)))
        (if (local.get $auto_i32_1) (then (local.set $auto_i32_4 (i32.or (i32.shl (local.get $auto_i32_2) (local.get $auto_i32_1)) (i32.shr_u (local.get $auto_i32_3) (i32.sub (i32.const 32) (local.get $auto_i32_1))))) (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_4)) (call $set_flags_shift (local.get $auto_i32_4) (i32.and (i32.shr_u (local.get $auto_i32_2) (i32.sub (i32.const 32) (local.get $auto_i32_1))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 224: $th_shrd_m
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_2 (call $gl32 (local.get $auto_i32_0)))
        (local.set $auto_i32_3 (call $get_reg (local.get $auto_op)))
        (if (local.get $auto_i32_1) (then (local.set $auto_i32_4 (i32.or (i32.shr_u (local.get $auto_i32_2) (local.get $auto_i32_1)) (i32.shl (local.get $auto_i32_3) (i32.sub (i32.const 32) (local.get $auto_i32_1))))) (call $gs32 (local.get $auto_i32_0) (local.get $auto_i32_4)) (call $set_flags_shift (local.get $auto_i32_4) (i32.and (i32.shr_u (local.get $auto_i32_2) (i32.sub (local.get $auto_i32_1) (i32.const 1))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 225: $th_bsf_rm
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $gl32 (call $read_addr)))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 0)) (block $auto_h225_d (loop $auto_h225_l (br_if $auto_h225_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.add (local.get $auto_i32_1) (i32.const 1))) (br $auto_h225_l))) (call $set_reg (local.get $auto_op) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 226: $th_bsr_rm
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $gl32 (call $read_addr)))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 31)) (block $auto_h226_d (loop $auto_h226_l (br_if $auto_h226_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.sub (local.get $auto_i32_1) (i32.const 1))) (br $auto_h226_l))) (call $set_reg (local.get $auto_op) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 227: $th_bt_m_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 5)) (i32.const 2))))
        (local.set $auto_i32_3 (call $gl32 (local.get $auto_i32_2)))
        (call $set_cf_bit (local.get $auto_i32_3) (i32.and (local.get $auto_i32_1) (i32.const 31)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 228: $th_bts_m_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 5)) (i32.const 2))))
        (local.set $auto_i32_3 (call $gl32 (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_i32_1) (i32.const 31)))
        (call $set_cf_bit (local.get $auto_i32_3) (local.get $auto_i32_4))
        (call $gs32 (local.get $auto_i32_2) (i32.or (local.get $auto_i32_3) (i32.shl (i32.const 1) (local.get $auto_i32_4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 229: $th_btr_m_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 5)) (i32.const 2))))
        (local.set $auto_i32_3 (call $gl32 (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_i32_1) (i32.const 31)))
        (call $set_cf_bit (local.get $auto_i32_3) (local.get $auto_i32_4))
        (call $gs32 (local.get $auto_i32_2) (i32.and (local.get $auto_i32_3) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_4)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 230: $th_btc_m_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_op)))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 5)) (i32.const 2))))
        (local.set $auto_i32_3 (call $gl32 (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_i32_1) (i32.const 31)))
        (call $set_cf_bit (local.get $auto_i32_3) (local.get $auto_i32_4))
        (call $gs32 (local.get $auto_i32_2) (i32.xor (local.get $auto_i32_3) (i32.shl (i32.const 1) (local.get $auto_i32_4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 231: $th_pop_m32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (call $gs32 (local.get $auto_i32_0) (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 232: $th_pop_m32_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (call $gs32 (local.get $auto_i32_0) (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 233: $th_emms
        (global.set $fpu_tag (i32.const 0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 234: $th_inc_r8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg8 (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.add (local.get $auto_i32_0) (i32.const 1)) (i32.const 0xFF)))
        (call $set_reg8 (local.get $auto_op) (local.get $auto_i32_1))
        (call $set_flags_inc (local.get $auto_i32_0) (local.get $auto_i32_1))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 235: $th_dec_r8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg8 (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.sub (local.get $auto_i32_0) (i32.const 1)) (i32.const 0xFF)))
        (call $set_reg8 (local.get $auto_op) (local.get $auto_i32_1))
        (call $set_flags_dec (local.get $auto_i32_0) (local.get $auto_i32_1))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 236: $th_mov_r16_i16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 0xFFFF)))
        (call $set_reg (local.get $auto_op) (i32.or (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF0000)) (local.get $auto_i32_0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 237: $th_xchg_m8_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl8 (local.get $auto_i32_0)))
        (call $gs8 (local.get $auto_i32_0) (call $get_reg8 (local.get $auto_op)))
        (call $set_reg8 (local.get $auto_op) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 238: $th_xchg_m8_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word)))
        (local.set $auto_i32_1 (call $gl8 (local.get $auto_i32_0)))
        (call $gs8 (local.get $auto_i32_0) (call $get_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4))))
        (call $set_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 239: $th_mul8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.mul (i32.and (global.get $eax) (i32.const 0xFF)) (call $get_reg8 (local.get $auto_op))))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_0) (i32.const 0xFFFF))))
        (call $set_flags_mul (i32.ne (i32.and (local.get $auto_i32_0) (i32.const 0xFF00)) (i32.const 0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 240: $th_imul8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_1 (call $sign_ext8 (i32.and (global.get $eax) (i32.const 0xFF))))
        (local.set $auto_i32_2 (call $sign_ext8 (call $get_reg8 (local.get $auto_op))))
        (local.set $auto_i32_0 (i32.mul (local.get $auto_i32_1) (local.get $auto_i32_2)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_0) (i32.const 0xFFFF))))
        (call $set_flags_mul (i32.ne (call $sign_ext8 (i32.and (local.get $auto_i32_0) (i32.const 0xFF))) (local.get $auto_i32_0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 241: $th_div8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (local.set $auto_i32_1 (call $get_reg8 (local.get $auto_op)))
        (if (i32.eqz (local.get $auto_i32_1)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i32_2 (i32.div_u (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (if (i32.gt_u (local.get $auto_i32_2) (i32.const 0xFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.or (i32.and (local.get $auto_i32_2) (i32.const 0xFF)) (i32.shl (i32.rem_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 8)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 242: $th_idiv8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $auto_i32_0) (i32.const 0x8000)) (then (local.set $auto_i32_0 (i32.or (local.get $auto_i32_0) (i32.const 0xFFFF0000)))))
        (local.set $auto_i32_1 (call $sign_ext8 (call $get_reg8 (local.get $auto_op))))
        (if (i32.eqz (local.get $auto_i32_1)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i32_2 (i32.div_s (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (local.set $auto_i32_3 (i32.rem_s (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (if (i32.or (i32.gt_s (local.get $auto_i32_2) (i32.const 127)) (i32.lt_s (local.get $auto_i32_2) (i32.const -128))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.or (i32.and (local.get $auto_i32_2) (i32.const 0xFF)) (i32.shl (i32.and (local.get $auto_i32_3) (i32.const 0xFF)) (i32.const 8)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 243: $th_muldiv_m8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_6 (i32.const 0))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_0 (call $gl8 (local.get $auto_i32_1)))
        (if (i32.eq (local.get $auto_op) (i32.const 0)) (then (local.set $auto_i32_2 (i32.mul (i32.and (global.get $eax) (i32.const 0xFF)) (local.get $auto_i32_0))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_2) (i32.const 0xFFFF)))) (call $set_flags_mul (i32.ne (i32.and (local.get $auto_i32_2) (i32.const 0xFF00)) (i32.const 0))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_op) (i32.const 1)) (then (local.set $auto_i32_2 (i32.mul (call $sign_ext8 (i32.and (global.get $eax) (i32.const 0xFF))) (call $sign_ext8 (local.get $auto_i32_0)))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_2) (i32.const 0xFFFF)))) (call $set_flags_mul (i32.ne (call $sign_ext8 (i32.and (local.get $auto_i32_2) (i32.const 0xFF))) (local.get $auto_i32_2))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_op) (i32.const 2)) (then (local.set $auto_i32_3 (i32.and (global.get $eax) (i32.const 0xFFFF))) (if (i32.eqz (local.get $auto_i32_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (local.set $auto_i32_5 (i32.div_u (local.get $auto_i32_3) (local.get $auto_i32_0))) (if (i32.gt_u (local.get $auto_i32_5) (i32.const 0xFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.or (i32.and (local.get $auto_i32_5) (i32.const 0xFF)) (i32.shl (i32.rem_u (local.get $auto_i32_3) (local.get $auto_i32_0)) (i32.const 8))))) (br $auto_dispatch)))
        (local.set $auto_i32_3 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $auto_i32_3) (i32.const 0x8000)) (then (local.set $auto_i32_3 (i32.or (local.get $auto_i32_3) (i32.const 0xFFFF0000)))))
        (local.set $auto_i32_4 (call $sign_ext8 (local.get $auto_i32_0)))
        (if (i32.eqz (local.get $auto_i32_4)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i32_5 (i32.div_s (local.get $auto_i32_3) (local.get $auto_i32_4)))
        (local.set $auto_i32_6 (i32.rem_s (local.get $auto_i32_3) (local.get $auto_i32_4)))
        (if (i32.or (i32.gt_s (local.get $auto_i32_5) (i32.const 127)) (i32.lt_s (local.get $auto_i32_5) (i32.const -128))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.or (i32.and (local.get $auto_i32_5) (i32.const 0xFF)) (i32.shl (i32.and (local.get $auto_i32_6) (i32.const 0xFF)) (i32.const 8)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 244: $th_muldiv_m8_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_6 (i32.const 0))
        (local.set $auto_i32_7 (i32.const 0))
        (local.set $auto_i32_1 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_2 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_0 (call $gl8 (local.get $auto_i32_1)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 0)) (then (local.set $auto_i32_3 (i32.mul (i32.and (global.get $eax) (i32.const 0xFF)) (local.get $auto_i32_0))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))) (call $set_flags_mul (i32.ne (i32.and (local.get $auto_i32_3) (i32.const 0xFF00)) (i32.const 0))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 1)) (then (local.set $auto_i32_3 (i32.mul (call $sign_ext8 (i32.and (global.get $eax) (i32.const 0xFF))) (call $sign_ext8 (local.get $auto_i32_0)))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))) (call $set_flags_mul (i32.ne (call $sign_ext8 (i32.and (local.get $auto_i32_3) (i32.const 0xFF))) (local.get $auto_i32_3))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_i32_2) (i32.const 2)) (then (local.set $auto_i32_4 (i32.and (global.get $eax) (i32.const 0xFFFF))) (if (i32.eqz (local.get $auto_i32_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (local.set $auto_i32_6 (i32.div_u (local.get $auto_i32_4) (local.get $auto_i32_0))) (if (i32.gt_u (local.get $auto_i32_6) (i32.const 0xFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.or (i32.and (local.get $auto_i32_6) (i32.const 0xFF)) (i32.shl (i32.rem_u (local.get $auto_i32_4) (local.get $auto_i32_0)) (i32.const 8))))) (br $auto_dispatch)))
        (local.set $auto_i32_4 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $auto_i32_4) (i32.const 0x8000)) (then (local.set $auto_i32_4 (i32.or (local.get $auto_i32_4) (i32.const 0xFFFF0000)))))
        (local.set $auto_i32_5 (call $sign_ext8 (local.get $auto_i32_0)))
        (if (i32.eqz (local.get $auto_i32_5)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i32_6 (i32.div_s (local.get $auto_i32_4) (local.get $auto_i32_5)))
        (local.set $auto_i32_7 (i32.rem_s (local.get $auto_i32_4) (local.get $auto_i32_5)))
        (if (i32.or (i32.gt_s (local.get $auto_i32_6) (i32.const 127)) (i32.lt_s (local.get $auto_i32_6) (i32.const -128))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.or (i32.and (local.get $auto_i32_6) (i32.const 0xFF)) (i32.shl (i32.and (local.get $auto_i32_7) (i32.const 0xFF)) (i32.const 8)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 245: $th_shift_m8_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.const 8)) (i32.const 7)))
        (local.set $auto_i32_3 (i32.and (local.get $auto_i32_1) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_3) (i32.const 0xFF)) (then (local.set $auto_i32_3 (i32.and (global.get $ecx) (i32.const 31)))))
        (call $gs8 (local.get $auto_i32_0) (call $do_shift8 (local.get $auto_i32_2) (call $gl8 (local.get $auto_i32_0)) (local.get $auto_i32_3)))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 246: $th_shift_m16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (call $read_thread_word))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.const 8)) (i32.const 7)))
        (local.set $auto_i32_3 (i32.and (local.get $auto_i32_1) (i32.const 0xFF)))
        (if (i32.eq (local.get $auto_i32_3) (i32.const 0xFF)) (then (local.set $auto_i32_3 (i32.and (global.get $ecx) (i32.const 31)))))
        (call $gs16 (local.get $auto_i32_0) (call $do_shift16 (local.get $auto_i32_2) (call $gl16 (local.get $auto_i32_0)) (local.get $auto_i32_3)))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 247: $th_cmpsw
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (global.get $esi)))
        (local.set $auto_i32_1 (call $gl16 (global.get $edi)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (global.set $flag_sign_shift (i32.const 15))
        (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2))) (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 2))) (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 248: $th_rep_cmpsw
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (block $auto_h248_d (loop $auto_h248_l (br_if $auto_h248_d (i32.eqz (global.get $ecx))) (local.set $auto_i32_0 (call $gl16 (global.get $esi))) (local.set $auto_i32_1 (call $gl16 (global.get $edi))) (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1))) (global.set $flag_sign_shift (i32.const 15)) (if (global.get $df) (then (global.set $esi (i32.sub (global.get $esi) (i32.const 2))) (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $esi (i32.add (global.get $esi) (i32.const 2))) (global.set $edi (i32.add (global.get $edi) (i32.const 2))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (if (i32.eqz (local.get $auto_op)) (then (br_if $auto_h248_d (i32.ne (local.get $auto_i32_0) (local.get $auto_i32_1)))) (else (br_if $auto_h248_d (i32.eq (local.get $auto_i32_0) (local.get $auto_i32_1))))) (br $auto_h248_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 249: $th_scasw
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (local.set $auto_i32_1 (call $gl16 (global.get $edi)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (global.set $flag_sign_shift (i32.const 15))
        (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 2)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 250: $th_rep_scasw
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (block $auto_h250_d (loop $auto_h250_l (br_if $auto_h250_d (i32.eqz (global.get $ecx))) (local.set $auto_i32_1 (call $gl16 (global.get $edi))) (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1))) (global.set $flag_sign_shift (i32.const 15)) (if (global.get $df) (then (global.set $edi (i32.sub (global.get $edi) (i32.const 2)))) (else (global.set $edi (i32.add (global.get $edi) (i32.const 2))))) (global.set $ecx (i32.sub (global.get $ecx) (i32.const 1))) (if (i32.eqz (local.get $auto_op)) (then (br_if $auto_h250_d (i32.ne (local.get $auto_i32_0) (local.get $auto_i32_1)))) (else (br_if $auto_h250_d (i32.eq (local.get $auto_i32_0) (local.get $auto_i32_1))))) (br $auto_h250_l)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 251: $th_imul_r16_r16_i
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $sign_ext16 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 0xFFFF))))
        (local.set $auto_i32_2 (call $sign_ext16 (i32.and (local.get $auto_i32_0) (i32.const 0xFFFF))))
        (local.set $auto_i32_3 (i32.mul (local.get $auto_i32_1) (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))
        (call $set_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_4))
        (global.set $flag_op (i32.const 6))
        (global.set $flag_sign_shift (i32.const 15))
        (global.set $flag_b (i32.ne (local.get $auto_i32_3) (call $sign_ext16 (local.get $auto_i32_4))))
        (global.set $flag_res (local.get $auto_i32_4))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 252: $th_cmpxchg8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_3 (i32.and (global.get $eax) (i32.const 0xFF)))
        (if (i32.ge_u (local.get $auto_op) (i32.const 0x80)) (then (local.set $auto_op (i32.and (local.get $auto_op) (i32.const 0x7F))) (local.set $auto_i32_0 (call $get_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4)))) (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF))) (if (i32.eq (local.get $auto_i32_3) (local.get $auto_i32_0)) (then (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.const 0)) (global.set $flag_sign_shift (i32.const 7)) (call $set_reg8 (i32.shr_u (local.get $auto_op) (i32.const 4)) (call $get_reg8 (local.get $auto_i32_1)))) (else (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.sub (local.get $auto_i32_3) (local.get $auto_i32_0))) (global.set $flag_sign_shift (i32.const 7)) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFFFF00)) (local.get $auto_i32_0)))))) (else (local.set $auto_i32_1 (local.get $auto_op)) (local.set $auto_i32_2 (call $read_addr)) (local.set $auto_i32_0 (call $gl8 (local.get $auto_i32_2))) (if (i32.eq (local.get $auto_i32_3) (local.get $auto_i32_0)) (then (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.const 0)) (global.set $flag_sign_shift (i32.const 7)) (call $gs8 (local.get $auto_i32_2) (call $get_reg8 (local.get $auto_i32_1)))) (else (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.sub (local.get $auto_i32_3) (local.get $auto_i32_0))) (global.set $flag_sign_shift (i32.const 7)) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFFFF00)) (local.get $auto_i32_0)))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 253: $th_pushf16
        (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
        (call $gs16 (global.get $esp) (i32.and (call $build_eflags) (i32.const 0xFFFF)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 254: $th_popf16
        (call $load_eflags (i32.and (call $gl16 (global.get $esp)) (i32.const 0xFFFF)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 255: $th_xchg_ax_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (call $set_reg (local.get $auto_op) (i32.or (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF0000)) (local.get $auto_i32_0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 256: $th_cmovcc_rr16
        (if (call $eval_cc (i32.shr_u (local.get $auto_op) (i32.const 8))) (then (call $set_reg16 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)) (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 0xFFFF)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 257: $th_cmovcc_rm16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (call $read_addr)))
        (if (call $eval_cc (i32.shr_u (local.get $auto_op) (i32.const 4))) (then (call $set_reg16 (i32.and (local.get $auto_op) (i32.const 0xF)) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 258: $th_shld16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_3 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (local.get $auto_i32_3)) (i32.const 0xFFFF)))
        (local.set $auto_i32_2 (i32.and (call $get_reg (local.get $auto_i32_4)) (i32.const 0xFFFF)))
        (if (i32.and (i32.gt_u (local.get $auto_i32_0) (i32.const 0)) (i32.le_u (local.get $auto_i32_0) (i32.const 16))) (then (local.set $auto_i32_5 (i32.and (i32.or (i32.shl (local.get $auto_i32_1) (local.get $auto_i32_0)) (i32.shr_u (local.get $auto_i32_2) (i32.sub (i32.const 16) (local.get $auto_i32_0)))) (i32.const 0xFFFF))) (call $set_reg16 (local.get $auto_i32_3) (local.get $auto_i32_5)) (call $set_flags_shift (local.get $auto_i32_5) (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.sub (i32.const 16) (local.get $auto_i32_0))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 259: $th_shrd16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_3 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (local.get $auto_i32_3)) (i32.const 0xFFFF)))
        (local.set $auto_i32_2 (i32.and (call $get_reg (local.get $auto_i32_4)) (i32.const 0xFFFF)))
        (if (i32.and (i32.gt_u (local.get $auto_i32_0) (i32.const 0)) (i32.le_u (local.get $auto_i32_0) (i32.const 16))) (then (local.set $auto_i32_5 (i32.and (i32.or (i32.shr_u (local.get $auto_i32_1) (local.get $auto_i32_0)) (i32.shl (local.get $auto_i32_2) (i32.sub (i32.const 16) (local.get $auto_i32_0)))) (i32.const 0xFFFF))) (call $set_reg16 (local.get $auto_i32_3) (local.get $auto_i32_5)) (call $set_flags_shift (local.get $auto_i32_5) (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (i32.const 1))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 260: $th_shld16_m
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_2 (call $gl16 (local.get $auto_i32_0)))
        (local.set $auto_i32_3 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (if (i32.and (i32.gt_u (local.get $auto_i32_1) (i32.const 0)) (i32.le_u (local.get $auto_i32_1) (i32.const 16))) (then (local.set $auto_i32_4 (i32.and (i32.or (i32.shl (local.get $auto_i32_2) (local.get $auto_i32_1)) (i32.shr_u (local.get $auto_i32_3) (i32.sub (i32.const 16) (local.get $auto_i32_1)))) (i32.const 0xFFFF))) (call $gs16 (local.get $auto_i32_0) (local.get $auto_i32_4)) (call $set_flags_shift (local.get $auto_i32_4) (i32.and (i32.shr_u (local.get $auto_i32_2) (i32.sub (i32.const 16) (local.get $auto_i32_1))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 261: $th_shrd16_m
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 31)))
        (local.set $auto_i32_2 (call $gl16 (local.get $auto_i32_0)))
        (local.set $auto_i32_3 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (if (i32.and (i32.gt_u (local.get $auto_i32_1) (i32.const 0)) (i32.le_u (local.get $auto_i32_1) (i32.const 16))) (then (local.set $auto_i32_4 (i32.and (i32.or (i32.shr_u (local.get $auto_i32_2) (local.get $auto_i32_1)) (i32.shl (local.get $auto_i32_3) (i32.sub (i32.const 16) (local.get $auto_i32_1)))) (i32.const 0xFFFF))) (call $gs16 (local.get $auto_i32_0) (local.get $auto_i32_4)) (call $set_flags_shift (local.get $auto_i32_4) (i32.and (i32.shr_u (local.get $auto_i32_2) (i32.sub (local.get $auto_i32_1) (i32.const 1))) (i32.const 1)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 262: $th_bsf16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 0xFFFF)))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 0)) (block $auto_h262_d (loop $auto_h262_l (br_if $auto_h262_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.add (local.get $auto_i32_1) (i32.const 1))) (br $auto_h262_l))) (call $set_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 263: $th_bsr16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 0xFFFF)))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 15)) (block $auto_h263_d (loop $auto_h263_l (br_if $auto_h263_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.sub (local.get $auto_i32_1) (i32.const 1))) (br $auto_h263_l))) (call $set_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 264: $th_bsf16_m
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (call $read_addr)))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 0)) (block $auto_h264_d (loop $auto_h264_l (br_if $auto_h264_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.add (local.get $auto_i32_1) (i32.const 1))) (br $auto_h264_l))) (call $set_reg16 (local.get $auto_op) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 265: $th_bsr16_m
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (call $read_addr)))
        (if (i32.eqz (local.get $auto_i32_0)) (then (call $set_flags_logic (i32.const 0))) (else (local.set $auto_i32_1 (i32.const 15)) (block $auto_h265_d (loop $auto_h265_l (br_if $auto_h265_d (i32.and (i32.shr_u (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 1))) (local.set $auto_i32_1 (i32.sub (local.get $auto_i32_1) (i32.const 1))) (br $auto_h265_l))) (call $set_reg16 (local.get $auto_op) (local.get $auto_i32_1)) (call $set_flags_logic (i32.const 1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 266: $th_call_rel16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
        (call $gs16 (global.get $esp) (i32.and (local.get $auto_op) (i32.const 0xFFFF)))
        (global.set $eip (local.get $auto_i32_0))
        (br $auto_done)
        ) ;; 267: $th_push_m16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (call $read_addr)))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
        (call $gs16 (global.get $esp) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 268: $th_pop_m16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (call $gs16 (local.get $auto_i32_0) (call $gl16 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 2)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 269: $th_push_m16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $gl16 (call $ea_from_op (local.get $auto_op))))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 2)))
        (call $gs16 (global.get $esp) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 270: $th_xchg_m16_r
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $gl16 (local.get $auto_i32_0)))
        (call $gs16 (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (call $set_reg (local.get $auto_op) (i32.or (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF0000)) (local.get $auto_i32_1)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 271: $th_xchg_m16_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_2 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_0 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (call $read_thread_word)))
        (local.set $auto_i32_1 (call $gl16 (local.get $auto_i32_0)))
        (call $gs16 (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_2)) (i32.const 0xFFFF)))
        (call $set_reg (local.get $auto_i32_2) (i32.or (i32.and (call $get_reg (local.get $auto_i32_2)) (i32.const 0xFFFF0000)) (local.get $auto_i32_1)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 272: $th_xchg_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (call $get_reg (local.get $auto_i32_0)) (i32.const 0xFFFF)))
        (local.set $auto_i32_3 (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)))
        (call $set_reg (local.get $auto_i32_0) (i32.or (i32.and (call $get_reg (local.get $auto_i32_0)) (i32.const 0xFFFF0000)) (local.get $auto_i32_3)))
        (call $set_reg (local.get $auto_i32_1) (i32.or (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF0000)) (local.get $auto_i32_2)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 273: $th_test_m16_r
        (call $set_flags_logic (i32.and (i32.and (call $gl16 (call $read_addr)) (i32.const 0xFFFF)) (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 274: $th_test_m16_r_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (call $set_flags_logic (i32.and (i32.and (call $gl16 (local.get $auto_i32_0)) (i32.const 0xFFFF)) (i32.and (call $get_reg (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF))) (i32.const 0xFFFF))))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 275: $th_test_m16_i
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (call $set_flags_logic (i32.and (i32.and (call $gl16 (local.get $auto_i32_0)) (i32.const 0xFFFF)) (i32.and (call $read_thread_word) (i32.const 0xFFFF))))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 276: $th_test_m16_i_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (call $set_flags_logic (i32.and (i32.and (call $gl16 (local.get $auto_i32_0)) (i32.const 0xFFFF)) (i32.and (call $read_thread_word) (i32.const 0xFFFF))))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 277: $th_cmpxchg16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_3 (i32.and (global.get $eax) (i32.const 0xFFFF)))
        (if (i32.ge_u (local.get $auto_op) (i32.const 0x80)) (then (local.set $auto_op (i32.and (local.get $auto_op) (i32.const 0x7F))) (local.set $auto_i32_0 (i32.and (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4))) (i32.const 0xFFFF))) (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF))) (if (i32.eq (local.get $auto_i32_3) (local.get $auto_i32_0)) (then (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.const 0)) (global.set $flag_sign_shift (i32.const 15)) (call $set_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)))) (else (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.and (i32.sub (local.get $auto_i32_3) (local.get $auto_i32_0)) (i32.const 0xFFFF))) (global.set $flag_sign_shift (i32.const 15)) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (local.get $auto_i32_0)))))) (else (local.set $auto_i32_1 (local.get $auto_op)) (local.set $auto_i32_2 (call $read_addr)) (local.set $auto_i32_0 (i32.and (call $gl16 (local.get $auto_i32_2)) (i32.const 0xFFFF))) (if (i32.eq (local.get $auto_i32_3) (local.get $auto_i32_0)) (then (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.const 0)) (global.set $flag_sign_shift (i32.const 15)) (call $gs16 (local.get $auto_i32_2) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)))) (else (call $set_flags_sub (local.get $auto_i32_3) (local.get $auto_i32_0) (i32.and (i32.sub (local.get $auto_i32_3) (local.get $auto_i32_0)) (i32.const 0xFFFF))) (global.set $flag_sign_shift (i32.const 15)) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (local.get $auto_i32_0)))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 278: $th_xadd16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (if (i32.ge_u (local.get $auto_op) (i32.const 0x80)) (then (local.set $auto_op (i32.and (local.get $auto_op) (i32.const 0x7F))) (local.set $auto_i32_1 (i32.and (local.get $auto_op) (i32.const 0xF))) (local.set $auto_i32_0 (i32.and (call $get_reg (i32.shr_u (local.get $auto_op) (i32.const 4))) (i32.const 0xFFFF))) (local.set $auto_i32_2 (i32.and (i32.add (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF))) (i32.const 0xFFFF))) (call $set_flags_add (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)) (local.get $auto_i32_2)) (global.set $flag_sign_shift (i32.const 15)) (call $set_reg16 (local.get $auto_i32_1) (local.get $auto_i32_0)) (call $set_reg16 (i32.shr_u (local.get $auto_op) (i32.const 4)) (local.get $auto_i32_2))) (else (local.set $auto_i32_1 (local.get $auto_op)) (local.set $auto_i32_3 (call $read_addr)) (local.set $auto_i32_0 (i32.and (call $gl16 (local.get $auto_i32_3)) (i32.const 0xFFFF))) (local.set $auto_i32_2 (i32.and (i32.add (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF))) (i32.const 0xFFFF))) (call $set_flags_add (local.get $auto_i32_0) (i32.and (call $get_reg (local.get $auto_i32_1)) (i32.const 0xFFFF)) (local.get $auto_i32_2)) (global.set $flag_sign_shift (i32.const 15)) (call $set_reg16 (local.get $auto_i32_1) (local.get $auto_i32_0)) (call $gs16 (local.get $auto_i32_3) (local.get $auto_i32_2))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 279: $th_test_r16_i16
        (call $set_flags_logic (i32.and (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)) (i32.and (call $read_thread_word) (i32.const 0xFFFF))))
        (global.set $flag_sign_shift (i32.const 15))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 280: $th_xlat
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.load8_u (call $g2w (i32.add (global.get $ebx) (i32.and (global.get $eax) (i32.const 0xFF))))))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFFFF00)) (local.get $auto_i32_0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 281: $th_unary_m16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $gl16 (local.get $auto_i32_0)) (i32.const 0xFFFF)))
        (if (i32.eq (local.get $auto_op) (i32.const 0)) (then (local.set $auto_i32_2 (i32.and (i32.add (local.get $auto_i32_1) (i32.const 1)) (i32.const 0xFFFF))) (call $set_flags_inc (local.get $auto_i32_1) (local.get $auto_i32_2)) (global.set $flag_sign_shift (i32.const 15))))
        (if (i32.eq (local.get $auto_op) (i32.const 1)) (then (local.set $auto_i32_2 (i32.and (i32.sub (local.get $auto_i32_1) (i32.const 1)) (i32.const 0xFFFF))) (call $set_flags_dec (local.get $auto_i32_1) (local.get $auto_i32_2)) (global.set $flag_sign_shift (i32.const 15))))
        (if (i32.eq (local.get $auto_op) (i32.const 2)) (then (local.set $auto_i32_2 (i32.and (i32.xor (local.get $auto_i32_1) (i32.const 0xFFFF)) (i32.const 0xFFFF)))))
        (if (i32.eq (local.get $auto_op) (i32.const 3)) (then (local.set $auto_i32_2 (i32.and (i32.sub (i32.const 0) (local.get $auto_i32_1)) (i32.const 0xFFFF))) (call $set_flags_sub (i32.const 0) (local.get $auto_i32_1) (local.get $auto_i32_2)) (global.set $flag_sign_shift (i32.const 15))))
        (call $gs16 (local.get $auto_i32_0) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 282: $th_mul16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (local.set $auto_i32_1 (i32.mul (i32.and (global.get $eax) (i32.const 0xFFFF)) (local.get $auto_i32_0)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_1) (i32.const 0xFFFF))))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.const 16)) (i32.const 0xFFFF))))
        (call $set_flags_mul (i32.ne (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.const 16)) (i32.const 0xFFFF)) (i32.const 0)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 283: $th_imul16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $sign_ext16 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (call $sign_ext16 (i32.and (global.get $eax) (i32.const 0xFFFF)))) (i64.extend_i32_s (local.get $auto_i32_0))))
        (local.set $auto_i32_1 (i32.wrap_i64 (local.get $auto_i64_0)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_1) (i32.const 0xFFFF))))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.const 16)) (i32.const 0xFFFF))))
        (call $set_flags_mul (i64.ne (local.get $auto_i64_0) (i64.extend_i32_s (call $sign_ext16 (i32.and (local.get $auto_i32_1) (i32.const 0xFFFF))))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 284: $th_div16
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i64_0 (i64.extend_i32_u (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (local.set $auto_i64_1 (i64.extend_i32_u (i32.or (i32.shl (i32.and (global.get $edx) (i32.const 0xFFFF)) (i32.const 16)) (i32.and (global.get $eax) (i32.const 0xFFFF)))))
        (if (i64.eqz (local.get $auto_i64_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_2 (i64.div_u (local.get $auto_i64_1) (local.get $auto_i64_0)))
        (if (i64.gt_u (local.get $auto_i64_2) (i64.const 0xFFFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_2)) (i32.const 0xFFFF))))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (i64.rem_u (local.get $auto_i64_1) (local.get $auto_i64_0))) (i32.const 0xFFFF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 285: $th_idiv16
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i64_3 (i64.const 0))
        (local.set $auto_i64_0 (i64.extend_i32_s (call $sign_ext16 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))))
        (local.set $auto_i64_1 (i64.extend_i32_s (i32.or (i32.shl (i32.and (global.get $edx) (i32.const 0xFFFF)) (i32.const 16)) (i32.and (global.get $eax) (i32.const 0xFFFF)))))
        (if (i64.eqz (local.get $auto_i64_0)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_2 (i64.div_s (local.get $auto_i64_1) (local.get $auto_i64_0)))
        (if (i32.or (i64.gt_s (local.get $auto_i64_2) (i64.const 32767)) (i64.lt_s (local.get $auto_i64_2) (i64.const -32768))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_3 (i64.rem_s (local.get $auto_i64_1) (local.get $auto_i64_0)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_2)) (i32.const 0xFFFF))))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_3)) (i32.const 0xFFFF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 286: $th_muldiv_m16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i64_3 (i64.const 0))
        (local.set $auto_i64_4 (i64.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (local.get $auto_op))
        (local.set $auto_i32_2 (i32.and (call $gl16 (local.get $auto_i32_0)) (i32.const 0xFFFF)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 0)) (then (local.set $auto_i32_3 (i32.mul (i32.and (global.get $eax) (i32.const 0xFFFF)) (local.get $auto_i32_2))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))) (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.shr_u (local.get $auto_i32_3) (i32.const 16)) (i32.const 0xFFFF)))) (call $set_flags_mul (i32.ne (i32.and (i32.shr_u (local.get $auto_i32_3) (i32.const 16)) (i32.const 0xFFFF)) (i32.const 0))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 1)) (then (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (call $sign_ext16 (i32.and (global.get $eax) (i32.const 0xFFFF)))) (i64.extend_i32_s (call $sign_ext16 (local.get $auto_i32_2))))) (local.set $auto_i32_3 (i32.wrap_i64 (local.get $auto_i64_0))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))) (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.shr_u (local.get $auto_i32_3) (i32.const 16)) (i32.const 0xFFFF)))) (call $set_flags_mul (i64.ne (local.get $auto_i64_0) (i64.extend_i32_s (call $sign_ext16 (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 2)) (then (local.set $auto_i64_1 (i64.extend_i32_u (local.get $auto_i32_2))) (local.set $auto_i64_2 (i64.extend_i32_u (i32.or (i32.shl (i32.and (global.get $edx) (i32.const 0xFFFF)) (i32.const 16)) (i32.and (global.get $eax) (i32.const 0xFFFF))))) (if (i64.eqz (local.get $auto_i64_1)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (local.set $auto_i64_3 (i64.div_u (local.get $auto_i64_2) (local.get $auto_i64_1))) (if (i64.gt_u (local.get $auto_i64_3) (i64.const 0xFFFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_3)) (i32.const 0xFFFF)))) (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (i64.rem_u (local.get $auto_i64_2) (local.get $auto_i64_1))) (i32.const 0xFFFF)))) (br $auto_dispatch)))
        (local.set $auto_i64_1 (i64.extend_i32_s (call $sign_ext16 (local.get $auto_i32_2))))
        (local.set $auto_i64_2 (i64.extend_i32_s (i32.or (i32.shl (i32.and (global.get $edx) (i32.const 0xFFFF)) (i32.const 16)) (i32.and (global.get $eax) (i32.const 0xFFFF)))))
        (if (i64.eqz (local.get $auto_i64_1)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_3 (i64.div_s (local.get $auto_i64_2) (local.get $auto_i64_1)))
        (if (i32.or (i64.gt_s (local.get $auto_i64_3) (i64.const 32767)) (i64.lt_s (local.get $auto_i64_3) (i64.const -32768))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_4 (i64.rem_s (local.get $auto_i64_2) (local.get $auto_i64_1)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_3)) (i32.const 0xFFFF))))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_4)) (i32.const 0xFFFF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 287: $th_muldiv_m16_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i64_0 (i64.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i64_1 (i64.const 0))
        (local.set $auto_i64_2 (i64.const 0))
        (local.set $auto_i64_3 (i64.const 0))
        (local.set $auto_i64_4 (i64.const 0))
        (local.set $auto_i32_0 (call $ea_from_op (local.get $auto_op)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 0xF)))
        (local.set $auto_i32_2 (i32.and (call $gl16 (local.get $auto_i32_0)) (i32.const 0xFFFF)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 0)) (then (local.set $auto_i32_3 (i32.mul (i32.and (global.get $eax) (i32.const 0xFFFF)) (local.get $auto_i32_2))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))) (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.shr_u (local.get $auto_i32_3) (i32.const 16)) (i32.const 0xFFFF)))) (call $set_flags_mul (i32.ne (i32.and (i32.shr_u (local.get $auto_i32_3) (i32.const 16)) (i32.const 0xFFFF)) (i32.const 0))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 1)) (then (local.set $auto_i64_0 (i64.mul (i64.extend_i32_s (call $sign_ext16 (i32.and (global.get $eax) (i32.const 0xFFFF)))) (i64.extend_i32_s (call $sign_ext16 (local.get $auto_i32_2))))) (local.set $auto_i32_3 (i32.wrap_i64 (local.get $auto_i64_0))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))) (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.shr_u (local.get $auto_i32_3) (i32.const 16)) (i32.const 0xFFFF)))) (call $set_flags_mul (i64.ne (local.get $auto_i64_0) (i64.extend_i32_s (call $sign_ext16 (i32.and (local.get $auto_i32_3) (i32.const 0xFFFF)))))) (br $auto_dispatch)))
        (if (i32.eq (local.get $auto_i32_1) (i32.const 2)) (then (local.set $auto_i64_1 (i64.extend_i32_u (local.get $auto_i32_2))) (local.set $auto_i64_2 (i64.extend_i32_u (i32.or (i32.shl (i32.and (global.get $edx) (i32.const 0xFFFF)) (i32.const 16)) (i32.and (global.get $eax) (i32.const 0xFFFF))))) (if (i64.eqz (local.get $auto_i64_1)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (local.set $auto_i64_3 (i64.div_u (local.get $auto_i64_2) (local.get $auto_i64_1))) (if (i64.gt_u (local.get $auto_i64_3) (i64.const 0xFFFF)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done))) (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_3)) (i32.const 0xFFFF)))) (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (i64.rem_u (local.get $auto_i64_2) (local.get $auto_i64_1))) (i32.const 0xFFFF)))) (br $auto_dispatch)))
        (local.set $auto_i64_1 (i64.extend_i32_s (call $sign_ext16 (local.get $auto_i32_2))))
        (local.set $auto_i64_2 (i64.extend_i32_s (i32.or (i32.shl (i32.and (global.get $edx) (i32.const 0xFFFF)) (i32.const 16)) (i32.and (global.get $eax) (i32.const 0xFFFF)))))
        (if (i64.eqz (local.get $auto_i64_1)) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_3 (i64.div_s (local.get $auto_i64_2) (local.get $auto_i64_1)))
        (if (i32.or (i64.gt_s (local.get $auto_i64_3) (i64.const 32767)) (i64.lt_s (local.get $auto_i64_3) (i64.const -32768))) (then (call $raise_exception (i32.const 0xC0000094)) (br $auto_done)))
        (local.set $auto_i64_4 (i64.rem_s (local.get $auto_i64_2) (local.get $auto_i64_1)))
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_3)) (i32.const 0xFFFF))))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xFFFF0000)) (i32.and (i32.wrap_i64 (local.get $auto_i64_4)) (i32.const 0xFFFF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 288: $th_imul_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (call $finish_imul_r16 (local.get $auto_i32_0) (call $get_reg (local.get $auto_i32_0)) (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 289: $th_imul_r16_m
        (call $finish_imul_r16 (local.get $auto_op) (call $get_reg (local.get $auto_op)) (call $gl16 (call $read_addr)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 290: $th_imul_r16_m_ro
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (call $finish_imul_r16 (local.get $auto_i32_1) (call $get_reg (local.get $auto_i32_1)) (call $gl16 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 291: $th_bt_r16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 15)))
        (call $set_cf_bit16 (call $get_reg (local.get $auto_op)) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 292: $th_bts_r16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 15)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (call $set_cf_bit16 (local.get $auto_i32_1) (local.get $auto_i32_0))
        (call $set_reg16 (local.get $auto_op) (i32.or (local.get $auto_i32_1) (i32.shl (i32.const 1) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 293: $th_btr_r16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 15)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (call $set_cf_bit16 (local.get $auto_i32_1) (local.get $auto_i32_0))
        (call $set_reg16 (local.get $auto_op) (i32.and (local.get $auto_i32_1) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_0)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 294: $th_btc_r16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (call $read_thread_word) (i32.const 15)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF)))
        (call $set_cf_bit16 (local.get $auto_i32_1) (local.get $auto_i32_0))
        (call $set_reg16 (local.get $auto_op) (i32.xor (local.get $auto_i32_1) (i32.shl (i32.const 1) (local.get $auto_i32_0))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 295: $th_bt_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 15)))
        (call $set_cf_bit16 (call $get_reg (local.get $auto_i32_0)) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 296: $th_bts_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 15)))
        (local.set $auto_i32_2 (i32.and (call $get_reg (local.get $auto_i32_0)) (i32.const 0xFFFF)))
        (call $set_cf_bit16 (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $set_reg16 (local.get $auto_i32_0) (i32.or (local.get $auto_i32_2) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 297: $th_btr_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 15)))
        (local.set $auto_i32_2 (i32.and (call $get_reg (local.get $auto_i32_0)) (i32.const 0xFFFF)))
        (call $set_cf_bit16 (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $set_reg16 (local.get $auto_i32_0) (i32.and (local.get $auto_i32_2) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_1)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 298: $th_btc_r16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.shr_u (local.get $auto_op) (i32.const 4)))
        (local.set $auto_i32_1 (i32.and (call $get_reg (i32.and (local.get $auto_op) (i32.const 0xF))) (i32.const 15)))
        (local.set $auto_i32_2 (i32.and (call $get_reg (local.get $auto_i32_0)) (i32.const 0xFFFF)))
        (call $set_cf_bit16 (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $set_reg16 (local.get $auto_i32_0) (i32.xor (local.get $auto_i32_2) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 299: $th_bt_m16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 15)))
        (call $set_cf_bit16 (call $gl16 (local.get $auto_i32_0)) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 300: $th_bts_m16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 15)))
        (local.set $auto_i32_2 (call $gl16 (local.get $auto_i32_0)))
        (call $set_cf_bit16 (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $gs16 (local.get $auto_i32_0) (i32.or (local.get $auto_i32_2) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 301: $th_btr_m16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 15)))
        (local.set $auto_i32_2 (call $gl16 (local.get $auto_i32_0)))
        (call $set_cf_bit16 (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $gs16 (local.get $auto_i32_0) (i32.and (local.get $auto_i32_2) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_1)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 302: $th_btc_m16_i8
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (i32.and (call $read_thread_word) (i32.const 15)))
        (local.set $auto_i32_2 (call $gl16 (local.get $auto_i32_0)))
        (call $set_cf_bit16 (local.get $auto_i32_2) (local.get $auto_i32_1))
        (call $gs16 (local.get $auto_i32_0) (i32.xor (local.get $auto_i32_2) (i32.shl (i32.const 1) (local.get $auto_i32_1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 303: $th_bt_m16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $sign_ext16 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 4)) (i32.const 1))))
        (local.set $auto_i32_3 (call $gl16 (local.get $auto_i32_2)))
        (call $set_cf_bit16 (local.get $auto_i32_3) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 304: $th_bts_m16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $sign_ext16 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 4)) (i32.const 1))))
        (local.set $auto_i32_3 (call $gl16 (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_i32_1) (i32.const 15)))
        (call $set_cf_bit16 (local.get $auto_i32_3) (local.get $auto_i32_4))
        (call $gs16 (local.get $auto_i32_2) (i32.or (local.get $auto_i32_3) (i32.shl (i32.const 1) (local.get $auto_i32_4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 305: $th_btr_m16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $sign_ext16 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 4)) (i32.const 1))))
        (local.set $auto_i32_3 (call $gl16 (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_i32_1) (i32.const 15)))
        (call $set_cf_bit16 (local.get $auto_i32_3) (local.get $auto_i32_4))
        (call $gs16 (local.get $auto_i32_2) (i32.and (local.get $auto_i32_3) (i32.xor (i32.shl (i32.const 1) (local.get $auto_i32_4)) (i32.const -1))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 306: $th_btc_m16_r16
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_0 (call $read_addr))
        (local.set $auto_i32_1 (call $sign_ext16 (i32.and (call $get_reg (local.get $auto_op)) (i32.const 0xFFFF))))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (i32.shl (i32.shr_s (local.get $auto_i32_1) (i32.const 4)) (i32.const 1))))
        (local.set $auto_i32_3 (call $gl16 (local.get $auto_i32_2)))
        (local.set $auto_i32_4 (i32.and (local.get $auto_i32_1) (i32.const 15)))
        (call $set_cf_bit16 (local.get $auto_i32_3) (local.get $auto_i32_4))
        (call $gs16 (local.get $auto_i32_2) (i32.xor (local.get $auto_i32_3) (i32.shl (i32.const 1) (local.get $auto_i32_4))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 307: $th_jcc_o
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 0))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (call $get_of) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 308: $th_jcc_no
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 1))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.eqz (call $get_of)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 309: $th_jcc_b
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 2))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (call $get_cf) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 310: $th_jcc_ae
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 3))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.eqz (call $get_cf)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 311: $th_jcc_z
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 4))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (call $get_zf) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 312: $th_jcc_nz
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 5))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.eqz (call $get_zf)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 313: $th_jcc_be
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 6))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.or (call $get_cf) (call $get_zf)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 314: $th_jcc_a
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 7))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.and (i32.eqz (call $get_cf)) (i32.eqz (call $get_zf))) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 315: $th_jcc_s
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 8))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (call $get_sf) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 316: $th_jcc_ns
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 9))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.eqz (call $get_sf)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 317: $th_jcc_p
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 10))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.eqz (i32.and (i32.popcnt (i32.and (global.get $flag_res) (i32.const 0xFF))) (i32.const 1))) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 318: $th_jcc_np
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 11))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.and (i32.popcnt (i32.and (global.get $flag_res) (i32.const 0xFF))) (i32.const 1)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 319: $th_jcc_l
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 12))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.ne (call $get_sf) (call $get_of)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 320: $th_jcc_ge
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 13))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.eq (call $get_sf) (call $get_of)) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 321: $th_jcc_le
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 14))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.or (call $get_zf) (i32.ne (call $get_sf) (call $get_of))) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 322: $th_jcc_g
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $branch_hist_record_jcc (i32.const 15))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (if (i32.and (i32.eqz (call $get_zf)) (i32.eq (call $get_sf) (call $get_of))) (then (global.set $eip (local.get $auto_i32_1))) (else (global.set $eip (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 323: $th_push_eax
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $eax))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 324: $th_push_ecx
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $ecx))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 325: $th_push_edx
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $edx))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 326: $th_push_ebx
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $ebx))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 327: $th_push_esp
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (global.get $esp))
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 328: $th_push_ebp
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $ebp))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 329: $th_push_esi
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $esi))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 330: $th_push_edi
        (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
        (call $gs32 (global.get $esp) (global.get $edi))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 331: $th_pop_eax
        (global.set $eax (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 332: $th_pop_ecx
        (global.set $ecx (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 333: $th_pop_edx
        (global.set $edx (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 334: $th_pop_ebx
        (global.set $ebx (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 335: $th_pop_esp
        (global.set $esp (call $gl32 (global.get $esp)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 336: $th_pop_ebp
        (global.set $ebp (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 337: $th_pop_esi
        (global.set $esi (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 338: $th_pop_edi
        (global.set $edi (call $gl32 (global.get $esp)))
        (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 339: $th_load32_ro_base_eax
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.shl (local.get $auto_op) (i32.const 3)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $eax) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 340: $th_load32_ro_base_ecx
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 1)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $ecx) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 341: $th_load32_ro_base_edx
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 2)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $edx) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 342: $th_load32_ro_base_ebx
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 3)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $ebx) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 343: $th_load32_ro_base_esp
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 4)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $esp) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 344: $th_load32_ro_base_ebp
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 5)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $ebp) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 345: $th_load32_ro_base_esi
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 6)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $esi) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 346: $th_load32_ro_base_edi
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 3) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 7)))))
        (call $set_reg (local.get $auto_op) (call $gl32 (i32.add (global.get $edi) (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 347: $th_store32_ro_base_eax
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.shl (local.get $auto_op) (i32.const 3)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $eax) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 348: $th_store32_ro_base_ecx
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 1)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $ecx) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 349: $th_store32_ro_base_edx
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 2)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $edx) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 350: $th_store32_ro_base_ebx
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 3)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $ebx) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 351: $th_store32_ro_base_esp
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 4)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $esp) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 352: $th_store32_ro_base_ebp
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 5)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $ebp) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 353: $th_store32_ro_base_esi
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 6)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $esi) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 354: $th_store32_ro_base_edi
        (local.set $auto_i32_0 (i32.const 0))
        (if (global.get $handler_hist_enabled) (then (call $regform_hist_record (i32.const 4) (i32.or (i32.shl (local.get $auto_op) (i32.const 3)) (i32.const 7)))))
        (local.set $auto_i32_0 (call $read_thread_word))
        (call $gs32 (i32.add (global.get $edi) (local.get $auto_i32_0)) (call $get_reg (local.get $auto_op)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 355: $th_jmp_ind_sib_eax4_abs
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $gl32 (i32.add (local.get $auto_i32_0) (i32.shl (global.get $eax) (i32.const 2)))))
        (if (i32.and (i32.ge_u (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.lt_u (local.get $auto_i32_1) (global.get $thunk_guest_end))) (then (local.set $auto_i32_2 (call $gl32 (global.get $esp))) (call $win32_dispatch (i32.div_u (i32.sub (local.get $auto_i32_1) (global.get $thunk_guest_base)) (i32.const 8))) (if (global.get $steps) (then (global.set $eip (local.get $auto_i32_2)))) (br $auto_done)))
        (global.set $eip (local.get $auto_i32_1))
        (br $auto_done)
        ) ;; 356: $th_stack_packet
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_4 (i32.const 0))
        (local.set $auto_i32_5 (i32.const 0))
        (local.set $auto_i32_6 (i32.const 0))
        (local.set $auto_i32_7 (i32.const 0))
        (local.set $auto_i32_8 (i32.const 0))
        (local.set $auto_i32_9 (i32.const 0))
        (local.set $auto_i32_10 (i32.const 0))
        (local.set $auto_i32_11 (i32.const 0))
        (local.set $auto_i32_12 (i32.const 0))
        (local.set $auto_i32_13 (i32.const 0))
        (local.set $auto_i32_14 (i32.const 0))
        (local.set $auto_i32_15 (i32.const 0))
        (local.set $auto_i32_16 (i32.const 0))
        (local.set $auto_i32_17 (i32.const 0))
        (local.set $auto_i32_18 (i32.const 0))
        (local.set $auto_i32_19 (i32.const 0))
        (local.set $auto_i32_20 (i32.const 0))
        (local.set $auto_i32_21 (i32.const 0))
        (local.set $auto_i32_22 (i32.const 0))
        (local.set $auto_i32_23 (i32.const 0))
        (local.set $auto_i32_24 (i32.const 0))
        (local.set $auto_i32_25 (i32.const 0))
        (local.set $auto_i32_26 (i32.const 0))
        (local.set $auto_i32_27 (i32.const 0))
        (local.set $auto_i32_28 (i32.const 0))
        (local.set $auto_i32_29 (i32.const 0))
        (if (i32.eq (local.get $auto_op) (i32.const 1)) (then (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_entries (i32.add (global.get $stack_packet_entries) (i32.const 1))) (global.set $stack_packet_0049d9d1_entries (i32.add (global.get $stack_packet_0049d9d1_entries) (i32.const 1))))) (local.set $auto_i32_0 (call $gl32 (i32.add (global.get $esi) (i32.const 0x18)))) (local.set $auto_i32_1 (call $gl32 (i32.add (global.get $esi) (i32.const 0x14)))) (local.set $auto_i32_2 (call $gl32 (global.get $esi))) (local.set $auto_i32_7 (i32.shl (local.get $auto_i32_0) (i32.const 4))) (local.set $auto_i32_3 (call $gl32 (i32.add (local.get $auto_i32_2) (i32.shl (local.get $auto_i32_1) (i32.const 2))))) (local.set $auto_i32_8 (i32.add (local.get $auto_i32_3) (local.get $auto_i32_7))) (local.set $auto_i32_4 (call $gl32 (i32.add (global.get $esi) (i32.const 0x20)))) (local.set $auto_i32_9 (i32.sub (local.get $auto_i32_4) (i32.const 1))) (local.set $auto_i32_10 (i32.add (local.get $auto_i32_0) (i32.const 1))) (call $gs32 (i32.add (global.get $esi) (i32.const 0x20)) (local.get $auto_i32_9)) (call $gs32 (i32.add (global.get $ebp) (i32.const -4)) (local.get $auto_i32_9)) (local.set $auto_i32_5 (call $gl32 (i32.add (global.get $esi) (i32.const 4)))) (call $gs32 (i32.add (global.get $esi) (i32.const 0x18)) (local.get $auto_i32_10)) (local.set $auto_i32_6 (call $gl32 (i32.add (local.get $auto_i32_5) (i32.shl (local.get $auto_i32_1) (i32.const 2))))) (global.set $eax (local.get $auto_i32_8)) (global.set $ecx (local.get $auto_i32_10)) (global.set $edx (local.get $auto_i32_1)) (global.set $edi (local.get $auto_i32_5)) (call $set_flags_sub (local.get $auto_i32_10) (local.get $auto_i32_6) (i32.sub (local.get $auto_i32_10) (local.get $auto_i32_6))) (if (i32.ne (local.get $auto_i32_10) (local.get $auto_i32_6)) (then (global.set $eip (i32.const 0x0049DA1A))) (else (global.set $eip (i32.const 0x0049D9F9)))) (br $auto_done)))
        (if (i32.ne (local.get $auto_op) (i32.const 2)) (then (call $host_log_i32 (i32.const 0xCA5A0BAD)) (global.set $eip (global.get $stack_packet_addr)) (br $auto_done)))
        (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_entries (i32.add (global.get $stack_packet_entries) (i32.const 1))) (global.set $stack_packet_0049dd20_entries (i32.add (global.get $stack_packet_0049dd20_entries) (i32.const 1)))))
        (local.set $auto_i32_11 (global.get $esp))
        (local.set $auto_i32_22 (call $g2w (i32.sub (local.get $auto_i32_11) (i32.const 16))))
        (i32.store offset=12 (local.get $auto_i32_22) (global.get $ebx))
        (i32.store offset=8 (local.get $auto_i32_22) (global.get $ebp))
        (i32.store offset=4 (local.get $auto_i32_22) (global.get $esi))
        (i32.store (local.get $auto_i32_22) (global.get $edi))
        (global.set $esp (i32.sub (local.get $auto_i32_11) (i32.const 16)))
        (local.set $auto_i32_12 (global.get $ecx))
        (local.set $auto_i32_23 (call $g2w (local.get $auto_i32_12)))
        (global.set $esi (local.get $auto_i32_12))
        (local.set $auto_i32_13 (i32.load offset=28 (local.get $auto_i32_22)))
        (global.set $edi (local.get $auto_i32_13))
        (local.set $auto_i32_16 (i32.load offset=0x60 (local.get $auto_i32_23)))
        (if (i32.lt_s (local.get $auto_i32_13) (local.get $auto_i32_16)) (then (call $set_flags_sub (local.get $auto_i32_13) (local.get $auto_i32_16) (i32.sub (local.get $auto_i32_13) (local.get $auto_i32_16))) (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_to_e0ad_entries (i32.add (global.get $stack_packet_0049dd20_to_e0ad_entries) (i32.const 1))))) (global.set $eip (i32.const 0x0049E0AD)) (br $auto_done)))
        (local.set $auto_i32_17 (i32.load offset=0x64 (local.get $auto_i32_23)))
        (if (i32.gt_s (local.get $auto_i32_13) (local.get $auto_i32_17)) (then (call $set_flags_sub (local.get $auto_i32_13) (local.get $auto_i32_17) (i32.sub (local.get $auto_i32_13) (local.get $auto_i32_17))) (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_to_e0ad_entries (i32.add (global.get $stack_packet_0049dd20_to_e0ad_entries) (i32.const 1))))) (global.set $eip (i32.const 0x0049E0AD)) (br $auto_done)))
        (local.set $auto_i32_15 (i32.load offset=24 (local.get $auto_i32_22)))
        (local.set $auto_i32_14 (i32.load offset=20 (local.get $auto_i32_22)))
        (if (i32.gt_s (local.get $auto_i32_14) (local.get $auto_i32_15)) (then (i32.store offset=24 (local.get $auto_i32_22) (local.get $auto_i32_14)) (i32.store offset=20 (local.get $auto_i32_22) (local.get $auto_i32_15)) (local.set $auto_i32_7 (local.get $auto_i32_14)) (local.set $auto_i32_14 (local.get $auto_i32_15)) (local.set $auto_i32_15 (local.get $auto_i32_7))))
        (local.set $auto_i32_18 (i32.load offset=0x58 (local.get $auto_i32_23)))
        (if (i32.lt_s (local.get $auto_i32_15) (local.get $auto_i32_18)) (then (global.set $eax (local.get $auto_i32_14)) (global.set $ebp (local.get $auto_i32_15)) (global.set $ecx (local.get $auto_i32_18)) (call $set_flags_sub (local.get $auto_i32_15) (local.get $auto_i32_18) (i32.sub (local.get $auto_i32_15) (local.get $auto_i32_18))) (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_to_e0ad_entries (i32.add (global.get $stack_packet_0049dd20_to_e0ad_entries) (i32.const 1))))) (global.set $eip (i32.const 0x0049E0AD)) (br $auto_done)))
        (local.set $auto_i32_19 (i32.load offset=0x5c (local.get $auto_i32_23)))
        (if (i32.gt_s (local.get $auto_i32_14) (local.get $auto_i32_19)) (then (global.set $eax (local.get $auto_i32_14)) (global.set $ebp (local.get $auto_i32_15)) (global.set $ecx (local.get $auto_i32_18)) (global.set $edx (local.get $auto_i32_19)) (call $set_flags_sub (local.get $auto_i32_14) (local.get $auto_i32_19) (i32.sub (local.get $auto_i32_14) (local.get $auto_i32_19))) (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_to_e0ad_entries (i32.add (global.get $stack_packet_0049dd20_to_e0ad_entries) (i32.const 1))))) (global.set $eip (i32.const 0x0049E0AD)) (br $auto_done)))
        (if (i32.lt_s (local.get $auto_i32_14) (local.get $auto_i32_18)) (then (i32.store offset=20 (local.get $auto_i32_22) (local.get $auto_i32_18)) (local.set $auto_i32_14 (local.get $auto_i32_18))))
        (if (i32.gt_s (local.get $auto_i32_15) (local.get $auto_i32_19)) (then (i32.store offset=24 (local.get $auto_i32_22) (local.get $auto_i32_19)) (local.set $auto_i32_15 (local.get $auto_i32_19))))
        (local.set $auto_i32_20 (i32.load offset=0x3c (local.get $auto_i32_23)))
        (local.set $auto_i32_13 (i32.shl (local.get $auto_i32_13) (i32.const 2)))
        (local.set $auto_i32_21 (i32.load (call $g2w (i32.add (local.get $auto_i32_20) (local.get $auto_i32_13)))))
        (global.set $eax (local.get $auto_i32_20))
        (global.set $ecx (local.get $auto_i32_18))
        (global.set $edx (local.get $auto_i32_19))
        (global.set $edi (local.get $auto_i32_13))
        (global.set $ebp (local.get $auto_i32_15))
        (global.set $ebx (local.get $auto_i32_21))
        (call $set_flags_logic (local.get $auto_i32_21))
        (if (local.get $auto_i32_21) (then (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_to_ddc7_entries (i32.add (global.get $stack_packet_0049dd20_to_ddc7_entries) (i32.const 1))))) (global.set $eip (i32.const 0x0049DDC7))) (else (local.set $auto_i32_4 (i32.load offset=0x20 (local.get $auto_i32_23))) (if (i32.eqz (local.get $auto_i32_4)) (then (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_to_dd8b_entries (i32.add (global.get $stack_packet_0049dd20_to_dd8b_entries) (i32.const 1))))) (global.set $eip (i32.const 0x0049DD8B)) (br $auto_done))) (local.set $auto_i32_24 (i32.load offset=0x10 (local.get $auto_i32_23))) (if (local.get $auto_i32_24) (then (local.set $auto_i32_25 (call $g2w (local.get $auto_i32_24))) (i32.store offset=0x10 (local.get $auto_i32_23) (i32.load (local.get $auto_i32_25))) (i32.store offset=0x20 (local.get $auto_i32_23) (i32.sub (local.get $auto_i32_4) (i32.const 1)))) (else (local.set $auto_i32_0 (i32.load offset=0x18 (local.get $auto_i32_23))) (local.set $auto_i32_1 (i32.load offset=0x14 (local.get $auto_i32_23))) (local.set $auto_i32_2 (i32.load (local.get $auto_i32_23))) (local.set $auto_i32_3 (i32.load (call $g2w (i32.add (local.get $auto_i32_2) (i32.shl (local.get $auto_i32_1) (i32.const 2)))))) (local.set $auto_i32_24 (i32.add (local.get $auto_i32_3) (i32.shl (local.get $auto_i32_0) (i32.const 4)))) (local.set $auto_i32_25 (call $g2w (local.get $auto_i32_24))) (local.set $auto_i32_4 (i32.sub (local.get $auto_i32_4) (i32.const 1))) (local.set $auto_i32_10 (i32.add (local.get $auto_i32_0) (i32.const 1))) (local.set $auto_i32_5 (i32.load offset=0x04 (local.get $auto_i32_23))) (local.set $auto_i32_6 (i32.load (call $g2w (i32.add (local.get $auto_i32_5) (i32.shl (local.get $auto_i32_1) (i32.const 2)))))) (if (i32.and (i32.eq (local.get $auto_i32_10) (local.get $auto_i32_6)) (i32.and (i32.eq (i32.add (local.get $auto_i32_1) (i32.const 1)) (i32.load offset=0x08 (local.get $auto_i32_23))) (i32.gt_s (local.get $auto_i32_4) (i32.const 0)))) (then (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_to_dd8b_entries (i32.add (global.get $stack_packet_0049dd20_to_dd8b_entries) (i32.const 1))))) (global.set $eip (i32.const 0x0049DD8B)) (br $auto_done))) (i32.store offset=0x20 (local.get $auto_i32_23) (local.get $auto_i32_4)) (i32.store offset=0x18 (local.get $auto_i32_23) (local.get $auto_i32_10)) (if (i32.eq (local.get $auto_i32_10) (local.get $auto_i32_6)) (then (local.set $auto_i32_9 (i32.add (local.get $auto_i32_1) (i32.const 1))) (i32.store offset=0x14 (local.get $auto_i32_23) (local.get $auto_i32_9)) (i32.store offset=0x18 (local.get $auto_i32_23) (i32.const 0)) (if (i32.eq (local.get $auto_i32_9) (i32.load offset=0x08 (local.get $auto_i32_23))) (then (i32.store offset=0x14 (local.get $auto_i32_23) (i32.const -1)))))))) (i32.store offset=0x04 (local.get $auto_i32_25) (i32.const 0)) (i32.store (local.get $auto_i32_25) (i32.const 0)) (i32.store offset=0x08 (local.get $auto_i32_25) (i32.load offset=20 (local.get $auto_i32_22))) (i32.store offset=0x0c (local.get $auto_i32_25) (local.get $auto_i32_15)) (local.set $auto_i32_26 (call $g2w (i32.add (local.get $auto_i32_20) (local.get $auto_i32_13)))) (i32.store (local.get $auto_i32_26) (local.get $auto_i32_24)) (local.set $auto_i32_9 (i32.load offset=0x40 (local.get $auto_i32_23))) (i32.store (call $g2w (i32.add (local.get $auto_i32_9) (local.get $auto_i32_13))) (local.get $auto_i32_24)) (local.set $auto_i32_8 (i32.load offset=0x44 (local.get $auto_i32_23))) (i32.store (call $g2w (i32.add (local.get $auto_i32_8) (local.get $auto_i32_13))) (i32.load offset=20 (local.get $auto_i32_22))) (local.set $auto_i32_10 (i32.load offset=0x48 (local.get $auto_i32_23))) (i32.store (call $g2w (i32.add (local.get $auto_i32_10) (local.get $auto_i32_13))) (local.get $auto_i32_15)) (local.set $auto_i32_6 (i32.load offset=0x4c (local.get $auto_i32_23))) (local.set $auto_i32_27 (i32.add (local.get $auto_i32_6) (local.get $auto_i32_13))) (local.set $auto_i32_26 (call $g2w (local.get $auto_i32_27))) (local.set $auto_i32_28 (i32.load (local.get $auto_i32_26))) (i32.store (local.get $auto_i32_26) (i32.add (local.get $auto_i32_28) (i32.const 1))) (call $set_flags_add (local.get $auto_i32_13) (local.get $auto_i32_6) (local.get $auto_i32_27)) (call $set_flags_inc (local.get $auto_i32_28) (i32.add (local.get $auto_i32_28) (i32.const 1))) (if (global.get $stack_packet_count_enabled) (then (global.set $stack_packet_0049dd20_empty_inline_entries (i32.add (global.get $stack_packet_0049dd20_empty_inline_entries) (i32.const 1))))) (local.set $auto_i32_29 (i32.load offset=16 (local.get $auto_i32_22))) (global.set $eax (local.get $auto_i32_8)) (global.set $ecx (local.get $auto_i32_10)) (global.set $edx (local.get $auto_i32_6)) (global.set $edi (i32.load (local.get $auto_i32_22))) (global.set $esi (i32.load offset=4 (local.get $auto_i32_22))) (global.set $ebp (i32.load offset=8 (local.get $auto_i32_22))) (global.set $ebx (i32.load offset=12 (local.get $auto_i32_22))) (global.set $esp (i32.add (local.get $auto_i32_11) (i32.const 16))) (global.set $eip (local.get $auto_i32_29)) (br $auto_done)))
        (br $auto_done)
        ) ;; 357: $th_aoe_recompile
        (if (i32.eq (local.get $auto_op) (i32.const 100)) (then (call $aoe_wat_threaded_packet) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 101)) (then (call $wat_stack_packet) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 102)) (then (call $wat_slot_packet) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 1)) (then (call $aoe_recompile_00535c20) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 2)) (then (call $aoe_recompile_simple_dispatch (i32.const 0x00534540)) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 3)) (then (call $aoe_recompile_simple_dispatch (i32.const 0x00534440)) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 4)) (then (call $aoe_recompile_00535e00) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 5)) (then (call $aoe_recompile_00535e08) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 6)) (then (call $aoe_recompile_00535e12) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 7)) (then (call $aoe_recompile_00535e17) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 8)) (then (call $aoe_recompile_00535e1e) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 9)) (then (call $aoe_recompile_00535e25) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 10)) (then (call $aoe_recompile_00535e2f) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 11)) (then (call $aoe_recompile_00535e40) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 12)) (then (call $aoe_recompile_00535e7c) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 13)) (then (call $aoe_recompile_00535e8a) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 14)) (then (call $aoe_recompile_00535bc0) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 15)) (then (call $aoe_recompile_00535b4d) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 16)) (then (call $aoe_recompile_00535b56) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 17)) (then (call $aoe_recompile_00535b5b) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 18)) (then (call $aoe_recompile_00535b66) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 19)) (then (call $aoe_recompile_00535b6b) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 20)) (then (call $aoe_recompile_00535b70) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 21)) (then (call $aoe_recompile_00535b8b) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 22)) (then (call $aoe_recompile_005362e0) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 24)) (then (call $aoe_recompile_00536528) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 25)) (then (call $aoe_recompile_00535e05) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 26)) (then (call $aoe_recompile_00535bdc) (br $auto_done)))
        (if (i32.eq (local.get $auto_op) (i32.const 27)) (then (call $aoe_recompile_005362f4) (br $auto_done)))
        (call $host_log_i32 (i32.const 0xA0E0BAD))
        (global.set $eip (i32.const 0x00535C20))
        (br $auto_done)
        ) ;; 358: $th_bench_sub_r_m32_direct_alu
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (i32.and (local.get $auto_op) (i32.const 15))))
        (local.set $auto_i32_1 (call $gl32 (call $read_thread_word)))
        (local.set $auto_i32_2 (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (call $set_reg (i32.and (local.get $auto_op) (i32.const 15)) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 359: $th_bench_shr_r_direct_alu
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (local.get $auto_op) (i32.const 255)))
        (local.set $auto_i32_1 (call $get_reg (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (i32.and (i32.shr_u (local.get $auto_op) (i32.const 16)) (i32.const 31)))
        (local.set $auto_i32_3 (i32.shr_u (local.get $auto_i32_1) (local.get $auto_i32_2)))
        (call $set_flags_shift (local.get $auto_i32_3) (i32.and (i32.shr_u (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_2) (i32.const 1))) (i32.const 1)))
        (call $set_reg (local.get $auto_i32_0) (local.get $auto_i32_3))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 360: $th_bench_cmp_r_m32_ro_direct_alu
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (call $get_reg (i32.and (i32.shr_u (local.get $auto_op) (i32.const 4)) (i32.const 15))))
        (local.set $auto_i32_1 (call $gl32 (i32.add (call $get_reg (i32.and (local.get $auto_op) (i32.const 15))) (call $read_thread_word))))
        (local.set $auto_i32_2 (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 361: $th_bench_jnz_direct
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (global.set $eip (if (result i32) (global.get $flag_res) (then (local.get $auto_i32_1)) (else (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 362: $th_bench_jl_direct
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (call $read_thread_word))
        (local.set $auto_i32_1 (call $read_thread_word))
        (global.set $eip (if (result i32) (i32.lt_s (global.get $flag_a) (global.get $flag_b)) (then (local.get $auto_i32_1)) (else (local.get $auto_i32_0))))
        (br $auto_done)
        ) ;; 363: $th_bench_store_esi_abs
        (call $gs32 (call $read_thread_word) (global.get $esi))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 364: $th_bench_xor_eax_eax
        (global.set $eax (i32.const 0))
        (call $set_flags_logic (i32.const 0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 365: $th_bench_store_edi_abs
        (call $gs32 (call $read_thread_word) (global.get $edi))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 366: $th_bench_load8_al_esi_disp
        (global.set $eax (i32.or (i32.and (global.get $eax) (i32.const 0xffffff00)) (call $gl8 (i32.add (global.get $esi) (call $read_thread_word)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 367: $th_bench_sub_edi_m32_generic_alu
        (global.set $edi (call $do_alu32 (i32.const 5) (global.get $edi) (call $gl32 (call $read_thread_word))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 368: $th_bench_mov_ecx_eax
        (global.set $ecx (global.get $eax))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 369: $th_bench_inc_esi
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (global.get $esi))
        (local.set $auto_i32_1 (i32.add (local.get $auto_i32_0) (i32.const 1)))
        (global.set $esi (local.get $auto_i32_1))
        (call $set_flags_inc (local.get $auto_i32_0) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 370: $th_bench_and_eax_i32
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $eax) (call $read_thread_word)))
        (global.set $eax (local.get $auto_i32_0))
        (call $set_flags_logic (local.get $auto_i32_0))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 371: $th_bench_load_ebx_abs
        (global.set $ebx (call $gl32 (call $read_thread_word)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 372: $th_bench_shr_ecx_generic_alu
        (global.set $ecx (call $do_shift32 (i32.const 5) (global.get $ecx) (i32.const 4)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 373: $th_bench_mov_edx_edi
        (global.set $edx (global.get $edi))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 374: $th_bench_add_edx_ecx
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (global.get $edx))
        (local.set $auto_i32_1 (global.get $ecx))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (global.set $edx (local.get $auto_i32_2))
        (call $set_flags_add (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 375: $th_bench_dec_edx
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (global.get $edx))
        (local.set $auto_i32_1 (i32.sub (local.get $auto_i32_0) (i32.const 1)))
        (global.set $edx (local.get $auto_i32_1))
        (call $set_flags_dec (local.get $auto_i32_0) (local.get $auto_i32_1))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 376: $th_bench_cmp_edx_ebx_disp_generic_alu
        (drop (call $do_alu32 (i32.const 7) (global.get $edx) (call $gl32 (i32.add (global.get $ebx) (call $read_thread_word)))))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 377: $th_bench_load_edi_abs
        (global.set $edi (call $gl32 (call $read_thread_word)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 378: $th_bench_add_edi_ecx
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (global.get $edi))
        (local.set $auto_i32_1 (global.get $ecx))
        (local.set $auto_i32_2 (i32.add (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (global.set $edi (local.get $auto_i32_2))
        (call $set_flags_add (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 379: $th_bench_sub_edi_m32_direct_alu
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (global.get $edi))
        (local.set $auto_i32_1 (call $gl32 (call $read_thread_word)))
        (local.set $auto_i32_2 (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (global.set $edi (local.get $auto_i32_2))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 380: $th_bench_shr_ecx_direct_alu
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (global.get $ecx))
        (local.set $auto_i32_1 (i32.shr_u (local.get $auto_i32_0) (i32.const 4)))
        (global.set $ecx (local.get $auto_i32_1))
        (call $set_flags_shift (local.get $auto_i32_1) (i32.and (i32.shr_u (local.get $auto_i32_0) (i32.const 3)) (i32.const 1)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 381: $th_bench_cmp_edx_ebx_disp_direct_alu
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_0 (global.get $edx))
        (local.set $auto_i32_1 (call $gl32 (i32.add (global.get $ebx) (call $read_thread_word))))
        (call $set_flags_sub (local.get $auto_i32_0) (local.get $auto_i32_1) (i32.sub (local.get $auto_i32_0) (local.get $auto_i32_1)))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 382: $th_hot_add_m8_eax_al
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.add (global.get $eax) (call $read_thread_word)))
        (local.set $auto_i32_1 (call $gl8 (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (i32.and (global.get $eax) (i32.const 0xff)))
        (local.set $auto_i32_3 (i32.add (local.get $auto_i32_1) (local.get $auto_i32_2)))
        (call $set_flags_add (local.get $auto_i32_1) (local.get $auto_i32_2) (local.get $auto_i32_3))
        (global.set $flag_sign_shift (i32.const 7))
        (call $gs8 (local.get $auto_i32_0) (local.get $auto_i32_3))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 383: $th_hot_add_m8_ecx_al
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_3 (i32.const 0))
        (local.set $auto_i32_0 (i32.add (global.get $ecx) (call $read_thread_word)))
        (local.set $auto_i32_1 (call $gl8 (local.get $auto_i32_0)))
        (local.set $auto_i32_2 (i32.and (global.get $eax) (i32.const 0xff)))
        (local.set $auto_i32_3 (i32.add (local.get $auto_i32_1) (local.get $auto_i32_2)))
        (call $set_flags_add (local.get $auto_i32_1) (local.get $auto_i32_2) (local.get $auto_i32_3))
        (global.set $flag_sign_shift (i32.const 7))
        (call $gs8 (local.get $auto_i32_0) (local.get $auto_i32_3))
        (br $auto_dispatch)
        (br $auto_done)
        ) ;; 384: $th_hot_add_dl_dh
        (local.set $auto_i32_0 (i32.const 0))
        (local.set $auto_i32_1 (i32.const 0))
        (local.set $auto_i32_2 (i32.const 0))
        (local.set $auto_i32_0 (i32.and (global.get $edx) (i32.const 0xff)))
        (local.set $auto_i32_1 (i32.and (i32.shr_u (global.get $edx) (i32.const 8)) (i32.const 0xff)))
        (local.set $auto_i32_2 (i32.and (i32.add (local.get $auto_i32_0) (local.get $auto_i32_1)) (i32.const 0xff)))
        (global.set $edx (i32.or (i32.and (global.get $edx) (i32.const 0xffffff00)) (local.get $auto_i32_2)))
        (call $set_flags_add (local.get $auto_i32_0) (local.get $auto_i32_1) (local.get $auto_i32_2))
        (global.set $flag_sign_shift (i32.const 7))
        (br $auto_dispatch)
        (br $auto_done)
      ) ;; corrupt handler ID
      (call $host_log_i32 (i32.const 0xCAC4BAD0))
      (call $host_log_i32 (local.get $auto_fn))
      (call $host_log_i32 (global.get $eip))
      (global.set $thread_alloc (global.get $THREAD_BASE))
      (call $clear_cache)
      (br $auto_done)
    ))
  )
