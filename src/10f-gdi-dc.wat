  ;; ============================================================
  ;; GDI DEVICE CONTEXT STATE
  ;; DC state records, save/restore, selected objects, surface descriptors, text
  ;; metrics and the host_gdi_* entry points that used to look like imports.
  ;; ============================================================

  (func $gdi_dc_state_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32) (local $limit i32)
    (local $hwnd i32) (local $binding i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (local.set $p (global.get $gdi_dc_state_hint))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load (local.get $p)) (local.get $hdc)))
      (then (return (local.get $p))))
    (local.set $limit (call $gdi_table_mark_limit
      (i32.const 2) (global.get $GDI_DC_STATE_COUNT)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $limit)))
      (local.set $p (i32.add (global.get $GDI_DC_STATE_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_DC_STATE_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc))
        (then
          (global.set $gdi_dc_state_hint (local.get $p))
          (return (local.get $p))))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Recognize legacy internal window DC encodings during lookup itself so
    ;; a geometry operation can be the first consumer; adoption must not
    ;; depend on an earlier SelectObject/text-state call creating the record.
    (if (i32.and (i32.ge_u (local.get $hdc) (i32.const 0x00050000))
          (i32.lt_u (local.get $hdc) (i32.const 0x000D0000)))
      (then
        (local.set $hwnd (i32.sub (local.get $hdc) (i32.const 0x00040000)))
        (if (i32.ne (call $wnd_table_find (local.get $hwnd)) (i32.const -1))
          (then (local.set $binding (local.get $hwnd))))))
    (if (i32.and (i32.ge_u (local.get $hdc) (i32.const 0x000D0000))
          (i32.lt_u (local.get $hdc) (i32.const 0x001D0000)))
      (then
        (local.set $hwnd (i32.sub (local.get $hdc) (i32.const 0x000C0000)))
        (if (i32.ne (call $wnd_table_find (local.get $hwnd)) (i32.const -1))
          (then (local.set $binding
            (i32.or (local.get $hwnd) (i32.const 0x80000000)))))))
    (if (i32.and (i32.or (i32.ne (local.get $create) (i32.const 0))
                          (i32.ne (local.get $binding) (i32.const 0)))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (memory.fill (local.get $empty) (i32.const 0) (global.get $GDI_DC_STATE_STRIDE))
        (i32.store (local.get $empty) (local.get $hdc))
        (i32.store offset=4 (local.get $empty) (i32.const 0x30017))
        (i32.store offset=8 (local.get $empty) (i32.const 0x30010))
        (i32.store offset=24 (local.get $empty) (i32.const 0xFFFFFF))
        (i32.store offset=28 (local.get $empty) (i32.const 2))
        (i32.store offset=36 (local.get $empty) (i32.const 1))
        (i32.store offset=48 (local.get $empty) (i32.const 1))
        (i32.store offset=52 (local.get $empty) (i32.const 1))
        (i32.store offset=64 (local.get $empty) (i32.const 1))
        (i32.store offset=68 (local.get $empty) (i32.const 1))
        (i32.store offset=72 (local.get $empty) (i32.const 13))
        (i32.store offset=76 (local.get $empty) (i32.const 1))
        (i32.store offset=80 (local.get $empty) (i32.const 1))
        (i32.store offset=84 (local.get $empty) (i32.const 0x30007))
        (i32.store offset=88 (local.get $empty) (i32.const 0x3001D))
        ;; WAT-native controls historically used hwnd+0x40000 directly as a
        ;; client DC, while nonclient painters used hwnd+0xC0000. Adopt those
        ;; values into the same canonical table as GetDC/BeginPaint handles.
        ;; The encoding is only accepted when it resolves to a live WAT HWND,
        ;; so ordinary allocated DC/object namespaces cannot be misclassified.
        (if (local.get $binding)
          (then (i32.store offset=92 (local.get $empty) (local.get $binding))))
        (global.set $gdi_dc_state_hint (local.get $empty))
        (call $gdi_table_mark_bump (i32.const 2) (i32.add (i32.div_u
          (i32.sub (local.get $empty) (global.get $GDI_DC_STATE_TABLE))
          (global.get $GDI_DC_STATE_STRIDE)) (i32.const 1)))
        (return (local.get $empty))))
    (i32.const 0))

  (func $gdi_dc_get_field (param $hdc i32) (param $offset i32) (param $default i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $entry)) (then (return (local.get $default))))
    (i32.load (i32.add (local.get $entry) (local.get $offset))))

  (func $gdi_dc_set_field (param $hdc i32) (param $offset i32) (param $value i32)
        (param $default i32) (result i32)
    (local $entry i32) (local $old i32)
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $old (i32.load (i32.add (local.get $entry) (local.get $offset))))
    (i32.store (i32.add (local.get $entry) (local.get $offset)) (local.get $value))
    (local.get $old))

  ;; Extended per-DC state that does not fit the stable 96-byte hot record:
  ;; hdc, arc direction, brush origin x/y, mapper flags, character extra,
  ;; and justification extra/break count. COLORADJUSTMENT uses a parallel
  ;; fixed table indexed by this DC's canonical state slot.
  (func $gdi_dc_aux_entry (param $hdc i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_AUX_COUNT)))
      (local.set $p (i32.add (global.get $GDI_DC_AUX_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_DC_AUX_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc))
        (then (return (local.get $p))))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (memory.fill (local.get $empty) (i32.const 0) (global.get $GDI_DC_AUX_STRIDE))
        (i32.store (local.get $empty) (local.get $hdc))
        (i32.store offset=4 (local.get $empty) (i32.const 1))
        (return (local.get $empty))))
    (i32.const 0))

  (func $gdi_dc_aux_get (param $hdc i32) (param $offset i32) (param $default i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $p)) (then (return (local.get $default))))
    (i32.load (i32.add (local.get $p) (local.get $offset))))

  (func $gdi_dc_aux_set (param $hdc i32) (param $offset i32) (param $value i32)
        (param $default i32) (result i32)
    (local $p i32) (local $old i32)
    (local.set $p (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const 0))))
    (local.set $old (i32.load (i32.add (local.get $p) (local.get $offset))))
    (i32.store (i32.add (local.get $p) (local.get $offset)) (local.get $value))
    (local.get $old))

  (func $gdi_dc_aux_release (param $hdc i32)
    (local $p i32)
    (local.set $p (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $p)
      (then (memory.fill (local.get $p) (i32.const 0) (global.get $GDI_DC_AUX_STRIDE)))))

  (func $gdi_color_adjustment_entry (param $hdc i32) (param $create i32) (result i32)
    (local $dc i32) (local $entry i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (local.get $create)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $GDI_COLOR_ADJUST_TABLE)
      (i32.div_u (i32.mul
        (i32.sub (local.get $dc) (global.get $GDI_DC_STATE_TABLE)) (i32.const 24))
        (global.get $GDI_DC_STATE_STRIDE))))
    (local.get $entry))

  (func $gdi_color_adjustment_init (param $entry i32)
    (if (i32.eqz (i32.load16_u (local.get $entry)))
      (then
        (i32.store16 (local.get $entry) (i32.const 24))
        (i32.store16 offset=2 (local.get $entry) (i32.const 0))
        (i32.store16 offset=4 (local.get $entry) (i32.const 0))
        (i32.store16 offset=6 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=8 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=10 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=12 (local.get $entry) (i32.const 0))
        (i32.store16 offset=14 (local.get $entry) (i32.const 10000))
        (i32.store16 offset=16 (local.get $entry) (i32.const 0))
        (i32.store16 offset=18 (local.get $entry) (i32.const 0))
        (i32.store16 offset=20 (local.get $entry) (i32.const 0))
        (i32.store16 offset=22 (local.get $entry) (i32.const 0)))))

  (func $gdi_color_adjustment_set (param $hdc i32) (param $src i32) (result i32)
    (local $entry i32) (local $contrast i32) (local $brightness i32)
    (local $colorfulness i32) (local $tint i32) (local $illuminant i32)
    (local $flags i32) (local $red_gamma i32) (local $green_gamma i32)
    (local $blue_gamma i32) (local $black i32) (local $white i32)
    (if (i32.eqz (local.get $src)) (then (return (i32.const 0))))
    (if (i32.ne (i32.load16_u (local.get $src)) (i32.const 24))
      (then (return (i32.const 0))))
    (local.set $flags (i32.load16_u offset=2 (local.get $src)))
    (local.set $illuminant (i32.load16_u offset=4 (local.get $src)))
    (local.set $red_gamma (i32.load16_u offset=6 (local.get $src)))
    (local.set $green_gamma (i32.load16_u offset=8 (local.get $src)))
    (local.set $blue_gamma (i32.load16_u offset=10 (local.get $src)))
    (local.set $black (i32.load16_u offset=12 (local.get $src)))
    (local.set $white (i32.load16_u offset=14 (local.get $src)))
    (local.set $contrast (i32.load16_s offset=16 (local.get $src)))
    (local.set $brightness (i32.load16_s offset=18 (local.get $src)))
    (local.set $colorfulness (i32.load16_s offset=20 (local.get $src)))
    (local.set $tint (i32.load16_s offset=22 (local.get $src)))
    (if (i32.or (i32.gt_u (local.get $flags) (i32.const 3))
      (i32.or (i32.gt_u (local.get $illuminant) (i32.const 8))
      (i32.or (i32.lt_u (local.get $red_gamma) (i32.const 2500))
      (i32.or (i32.gt_u (local.get $red_gamma) (i32.const 65000))
      (i32.or (i32.lt_u (local.get $green_gamma) (i32.const 2500))
      (i32.or (i32.gt_u (local.get $green_gamma) (i32.const 65000))
      (i32.or (i32.lt_u (local.get $blue_gamma) (i32.const 2500))
      (i32.or (i32.gt_u (local.get $blue_gamma) (i32.const 65000))
      (i32.or (i32.gt_u (local.get $black) (i32.const 4000))
      (i32.or (i32.lt_u (local.get $white) (i32.const 6000))
      (i32.or (i32.gt_u (local.get $white) (i32.const 10000))
          (i32.or (i32.lt_s (local.get $contrast) (i32.const -100))
            (i32.or (i32.gt_s (local.get $contrast) (i32.const 100))
              (i32.or (i32.lt_s (local.get $brightness) (i32.const -100))
                (i32.or (i32.gt_s (local.get $brightness) (i32.const 100))
                  (i32.or (i32.lt_s (local.get $colorfulness) (i32.const -100))
                    (i32.or (i32.gt_s (local.get $colorfulness) (i32.const 100))
                      (i32.or (i32.lt_s (local.get $tint) (i32.const -100))
                        (i32.gt_s (local.get $tint) (i32.const 100))))))))))))))))))))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (memory.copy (local.get $entry) (local.get $src) (i32.const 24))
    (i32.const 1))

  (func $gdi_color_adjustment_get (param $hdc i32) (param $dst i32) (result i32)
    (local $entry i32)
    (if (i32.eqz (local.get $dst)) (then (return (i32.const 0))))
    (local.set $entry (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (call $gdi_color_adjustment_init (local.get $entry))
    (memory.copy (local.get $dst) (local.get $entry) (i32.const 24))
    (i32.const 1))

  (func $gdi_gamma_ramp_set (param $hdc i32) (param $src i32) (result i32)
    (local $guest i32)
    (if (i32.or (i32.eqz (local.get $src))
          (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0))))
      (then (return (i32.const 0))))
    (if (i32.eqz (global.get $gdi_gamma_ramp_guest))
      (then
        (local.set $guest (call $heap_alloc (i32.const 1536)))
        (if (i32.eqz (local.get $guest)) (then (return (i32.const 0))))
        (global.set $gdi_gamma_ramp_guest (local.get $guest))))
    (memory.copy (call $g2w (global.get $gdi_gamma_ramp_guest))
      (local.get $src) (i32.const 1536))
    (i32.const 1))

  (func $gdi_gamma_ramp_get (param $hdc i32) (param $dst i32) (result i32)
    (local $channel i32) (local $index i32)
    (if (i32.or (i32.eqz (local.get $dst))
          (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0))))
      (then (return (i32.const 0))))
    (if (global.get $gdi_gamma_ramp_guest)
      (then
        (memory.copy (local.get $dst) (call $g2w (global.get $gdi_gamma_ramp_guest))
          (i32.const 1536))
        (return (i32.const 1))))
    (block $channels_done (loop $channels
      (br_if $channels_done (i32.ge_u (local.get $channel) (i32.const 3)))
      (local.set $index (i32.const 0))
      (block $entries_done (loop $entries
        (br_if $entries_done (i32.ge_u (local.get $index) (i32.const 256)))
        (i32.store16 (i32.add (local.get $dst)
            (i32.add (i32.mul (local.get $channel) (i32.const 512))
              (i32.shl (local.get $index) (i32.const 1))))
          (i32.mul (local.get $index) (i32.const 257)))
        (local.set $index (i32.add (local.get $index) (i32.const 1)))
        (br $entries)))
      (local.set $channel (i32.add (local.get $channel) (i32.const 1)))
      (br $channels)))
    (i32.const 1))

  (func $gdi_pixel_format_write (param $dst i32) (param $bytes i32)
        (result i32)
    (local $copy i32)
    (if (i32.eqz (local.get $dst)) (then (return (i32.const 1))))
    (local.set $copy (local.get $bytes))
    (if (i32.gt_u (local.get $copy) (i32.const 40))
      (then (local.set $copy (i32.const 40))))
    (memory.fill (local.get $dst) (i32.const 0) (local.get $copy))
    (if (i32.ge_u (local.get $copy) (i32.const 2))
      (then (i32.store16 (local.get $dst) (i32.const 40))))
    (if (i32.ge_u (local.get $copy) (i32.const 4))
      (then (i32.store16 offset=2 (local.get $dst) (i32.const 1))))
    (if (i32.ge_u (local.get $copy) (i32.const 8))
      (then (i32.store offset=4 (local.get $dst) (i32.const 0x00000025))))
    (if (i32.ge_u (local.get $copy) (i32.const 10))
      (then
        (i32.store8 offset=8 (local.get $dst) (i32.const 0))
        (i32.store8 offset=9 (local.get $dst) (i32.const 32))))
    (if (i32.ge_u (local.get $copy) (i32.const 18))
      (then
        (i32.store8 offset=10 (local.get $dst) (i32.const 8))
        (i32.store8 offset=11 (local.get $dst) (i32.const 16))
        (i32.store8 offset=12 (local.get $dst) (i32.const 8))
        (i32.store8 offset=13 (local.get $dst) (i32.const 8))
        (i32.store8 offset=14 (local.get $dst) (i32.const 8))
        (i32.store8 offset=15 (local.get $dst) (i32.const 0))
        (i32.store8 offset=16 (local.get $dst) (i32.const 8))
        (i32.store8 offset=17 (local.get $dst) (i32.const 24))))
    (if (i32.ge_u (local.get $copy) (i32.const 25))
      (then
        (i32.store8 offset=23 (local.get $dst) (i32.const 24))
        (i32.store8 offset=24 (local.get $dst) (i32.const 8))))
    (i32.const 1))

  (func $gdi_pixel_format_choose (param $hdc i32) (param $pfd i32) (result i32)
    (if (i32.or (i32.eqz (local.get $pfd))
          (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0))))
      (then (return (i32.const 0))))
    (if (i32.or (i32.ne (i32.load16_u (local.get $pfd)) (i32.const 40))
          (i32.ne (i32.load16_u offset=2 (local.get $pfd)) (i32.const 1)))
      (then (return (i32.const 0))))
    (i32.const 1))

  (func $gdi_pixel_format_set (param $hdc i32) (param $format i32)
        (param $pfd i32) (result i32)
    (if (i32.or (i32.ne (local.get $format) (i32.const 1))
          (i32.eqz (call $gdi_pixel_format_choose (local.get $hdc) (local.get $pfd))))
      (then (return (i32.const 0))))
    (if (i32.ne (call $gdi_dc_meta_get (local.get $hdc) (i32.const 16)
          (i32.const 0)) (i32.const 0))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_meta_set (local.get $hdc) (i32.const 16)
      (i32.const 1) (i32.const 0)))
    (i32.const 1))

  ;; A SaveDC node is 176 bytes in the guest heap:
  ;; next guest pointer, level, 96-byte hot state, 32-byte auxiliary state,
  ;; 24-byte COLORADJUSTMENT, selected palette, an owned clip snapshot,
  ;; graphics mode, and system-palette use.
  (func $gdi_dc_save_node_free (param $node_g i32)
    (local $node i32) (local $clip i32)
    (if (i32.eqz (local.get $node_g)) (then (return)))
    (local.set $node (call $g2w (local.get $node_g)))
    (local.set $clip (i32.load offset=164 (local.get $node)))
    (if (local.get $clip) (then (drop (call $gdi_rgn_delete (local.get $clip)))))
    (call $heap_free (local.get $node_g)))

  (func $gdi_dc_meta_release (param $hdc i32)
    (local $i i32) (local $p i32) (local $meta_g i32) (local $meta i32)
    (local $node_g i32) (local $next_g i32) (local $recording_bitmap i32)
    (local $profile_g i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_DC_SAVE_COUNT)))
      (local.set $p (i32.add (global.get $GDI_DC_SAVE_TABLE)
        (i32.shl (local.get $i) (i32.const 3))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $hdc)) (then (br $done)))
      (local.set $p (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (local.get $p)) (then (return)))
    (local.set $meta_g (i32.load offset=4 (local.get $p)))
    (if (local.get $meta_g)
      (then
        (local.set $meta (call $g2w (local.get $meta_g)))
        (if (i32.eq (i32.load offset=20 (local.get $meta)) (i32.const 0x4D464443))
          (then (local.set $recording_bitmap (i32.load offset=24 (local.get $meta)))))
        (local.set $profile_g (i32.load offset=32 (local.get $meta)))
        (local.set $node_g (i32.load offset=4 (local.get $meta)))
        (block $freed (loop $free
          (br_if $freed (i32.eqz (local.get $node_g)))
          (local.set $next_g (i32.load (call $g2w (local.get $node_g))))
          (call $gdi_dc_save_node_free (local.get $node_g))
          (local.set $node_g (local.get $next_g))
          (br $free)))
        (if (local.get $profile_g) (then (call $heap_free (local.get $profile_g))))
        (call $heap_free (local.get $meta_g))))
    (i64.store (local.get $p) (i64.const 0))
    (if (local.get $recording_bitmap)
      (then (drop (call $gdi_object_delete_full (local.get $recording_bitmap))))))

  (func $gdi_dc_save (param $hdc i32) (result i32)
    (local $dc i32) (local $aux i32) (local $color i32) (local $meta i32)
    (local $clip_entry i32) (local $clip i32) (local $clip_copy i32)
    (local $head_g i32) (local $node_g i32) (local $node i32) (local $level i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $meta)) (then (return (i32.const 0))))
    (local.set $head_g (i32.load offset=4 (local.get $meta)))
    (local.set $level (i32.const 1))
    (if (local.get $head_g)
      (then (local.set $level (i32.add
        (i32.load offset=4 (call $g2w (local.get $head_g))) (i32.const 1)))))
    (local.set $clip_entry (call $gdi_dc_clip_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $clip_entry)
      (then (local.set $clip (i32.load offset=4 (local.get $clip_entry)))))
    (if (local.get $clip)
      (then
        (local.set $clip_copy (call $gdi_rgn_alloc_rect
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
        (if (i32.or (i32.eqz (local.get $clip_copy))
              (i32.eqz (call $gdi_rgn_combine
                (local.get $clip_copy) (local.get $clip) (i32.const 0) (i32.const 5))))
          (then
            (if (local.get $clip_copy)
              (then (drop (call $gdi_rgn_delete (local.get $clip_copy)))))
            (return (i32.const 0))))))
    (local.set $node_g (call $heap_alloc (i32.const 176)))
    (if (i32.eqz (local.get $node_g))
      (then
        (if (local.get $clip_copy)
          (then (drop (call $gdi_rgn_delete (local.get $clip_copy)))))
        (return (i32.const 0))))
    (local.set $node (call $g2w (local.get $node_g)))
    (memory.fill (local.get $node) (i32.const 0) (i32.const 176))
    (i32.store (local.get $node) (local.get $head_g))
    (i32.store offset=4 (local.get $node) (local.get $level))
    (memory.copy (i32.add (local.get $node) (i32.const 8))
      (local.get $dc) (global.get $GDI_DC_STATE_STRIDE))
    (local.set $aux (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $aux)
      (then (memory.copy (i32.add (local.get $node) (i32.const 104))
        (local.get $aux) (global.get $GDI_DC_AUX_STRIDE))))
    (local.set $color (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $color)
      (then (memory.copy (i32.add (local.get $node) (i32.const 136))
        (local.get $color) (i32.const 24))))
    (i32.store offset=160 (local.get $node) (call $gdi_dc_selected_palette (local.get $hdc)))
    (i32.store offset=164 (local.get $node) (local.get $clip_copy))
    (i32.store offset=168 (local.get $node) (i32.load offset=8 (local.get $meta)))
    (i32.store offset=172 (local.get $node) (i32.load offset=12 (local.get $meta)))
    (i32.store offset=4 (local.get $meta) (local.get $node_g))
    (local.get $level))

  (func $gdi_dc_restore (param $hdc i32) (param $saved i32) (result i32)
    (local $dc i32) (local $meta i32) (local $head_g i32) (local $node_g i32) (local $node i32)
    (local $target_g i32) (local $target i32) (local $steps i32) (local $level i32)
    (local $aux i32) (local $color i32) (local $clip i32) (local $next_g i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (local.set $meta (call $gdi_dc_meta_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $dc))
          (i32.or (i32.eqz (local.get $meta)) (i32.eqz (local.get $saved))))
      (then (return (i32.const 0))))
    (local.set $head_g (i32.load offset=4 (local.get $meta)))
    (local.set $node_g (local.get $head_g))
    (if (i32.lt_s (local.get $saved) (i32.const 0))
      (then
        (local.set $steps (i32.sub (i32.const 0) (local.get $saved)))
        (if (i32.le_s (local.get $steps) (i32.const 0))
          (then (return (i32.const 0))))
        (block $relative_done (loop $relative
          (br_if $relative_done (i32.eqz (local.get $node_g)))
          (local.set $steps (i32.sub (local.get $steps) (i32.const 1)))
          (if (i32.eqz (local.get $steps))
            (then (local.set $target_g (local.get $node_g)) (br $relative_done)))
          (local.set $node_g (i32.load (call $g2w (local.get $node_g))))
          (br $relative))))
      (else
        (local.set $level (local.get $saved))
        (block $absolute_done (loop $absolute
          (br_if $absolute_done (i32.eqz (local.get $node_g)))
          (local.set $node (call $g2w (local.get $node_g)))
          (if (i32.eq (i32.load offset=4 (local.get $node)) (local.get $level))
            (then (local.set $target_g (local.get $node_g)) (br $absolute_done)))
          (local.set $node_g (i32.load (local.get $node)))
          (br $absolute)))))
    (if (i32.eqz (local.get $target_g)) (then (return (i32.const 0))))
    (local.set $target (call $g2w (local.get $target_g)))
    (if (i32.load (i32.add (local.get $target) (i32.const 104)))
      (then
        (local.set $aux (call $gdi_dc_aux_entry (local.get $hdc) (i32.const 1)))
        (if (i32.eqz (local.get $aux)) (then (return (i32.const 0))))))
    (local.set $clip (i32.load offset=164 (local.get $target)))
    (if (i32.eqz
          (if (result i32) (local.get $clip)
            (then (call $gdi_dc_clip_select (local.get $hdc) (local.get $clip)))
            (else (call $gdi_dc_clip_clear (local.get $hdc)))))
      (then (return (i32.const 0))))
    (memory.copy (local.get $dc) (i32.add (local.get $target) (i32.const 8))
      (global.get $GDI_DC_STATE_STRIDE))
    (if (i32.load (i32.add (local.get $target) (i32.const 104)))
      (then
        (memory.copy (local.get $aux) (i32.add (local.get $target) (i32.const 104))
          (global.get $GDI_DC_AUX_STRIDE)))
      (else (call $gdi_dc_aux_release (local.get $hdc))))
    (local.set $color (call $gdi_color_adjustment_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $color)
      (then (memory.copy (local.get $color) (i32.add (local.get $target) (i32.const 136))
        (i32.const 24))))
    (i32.store (local.get $meta) (i32.load offset=160 (local.get $target)))
    (i32.store offset=8 (local.get $meta) (i32.load offset=168 (local.get $target)))
    (i32.store offset=12 (local.get $meta) (i32.load offset=172 (local.get $target)))
    (i32.store offset=4 (local.get $meta) (i32.load (local.get $target)))
    ;; The restored node and every newer node are discarded.
    (local.set $node_g (local.get $head_g))
    (block $purged (loop $purge
      (br_if $purged (i32.eqz (local.get $node_g)))
      (local.set $next_g (i32.load (call $g2w (local.get $node_g))))
      (call $gdi_dc_save_node_free (local.get $node_g))
      (if (i32.eq (local.get $node_g) (local.get $target_g)) (then (br $purged)))
      (local.set $node_g (local.get $next_g))
      (br $purge)))
    (i32.const 1))

  (func $gdi_dc_select_owned_object (param $hdc i32) (param $handle i32) (result i32)
    (local $type i32)
    (local.set $type (call $gdi_object_type (local.get $handle)))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 4) (local.get $handle) (i32.const 0x30017)))))
    (if (i32.eq (local.get $type) (i32.const 2))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 8) (local.get $handle) (i32.const 0x30010)))))
    (if (i32.eq (local.get $type) (i32.const 3))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 84) (local.get $handle) (i32.const 0x30007)))))
    (if (i32.eq (local.get $type) (i32.const 4))
      (then (return (call $gdi_dc_set_field
        (local.get $hdc) (i32.const 88) (local.get $handle) (i32.const 0x3001D)))))
    (i32.const -1))

  (func $gdi_font_height (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 4)))
      (then (return (i32.load offset=8 (local.get $p)))))
    ;; OEM_FIXED_FONT is the native 8x12 Terminal stock object.
    (if (i32.eq (local.get $handle) (i32.const 0x3001A))
      (then (return (i32.const 12))))
    (if (i32.or (i32.eq (local.get $handle) (i32.const 0x3001B))
          (i32.eq (local.get $handle) (i32.const 0x30020)))
      (then (return (i32.const 16))))
    (if (i32.or (i32.eq (local.get $handle) (i32.const 0x30021))
          (i32.eq (local.get $handle) (i32.const 0x30022)))
      (then (return (i32.const 11))))
    (i32.const 12))

  (func $gdi_font_weight (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 4)))
      (then (return (i32.load offset=12 (local.get $p)))))
    (select (i32.const 700) (i32.const 400)
      (i32.eq (local.get $handle) (i32.const 0x30022))))

  (func $gdi_font_italic (param $handle i32) (result i32)
    (local $p i32)
    (local.set $p (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $p) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $p)) (i32.const 4)))
      (then (return (i32.and (i32.load offset=16 (local.get $p)) (i32.const 1)))))
    (i32.const 0))

  ;; Dynamic fonts are ordinary WAT-owned type-4 GDI objects. The bounded ANSI
  ;; face name lives in the guest heap and is referenced from record +28; +24
  ;; remains the optional installed FNT strike. Canvas receives this state only
  ;; when the selected face has no WAT bitmap strike.
  (func $gdi_font_create (param $height i32) (param $weight i32)
        (param $italic i32) (param $face i32) (result i32)
    (local $face_guest i32) (local $face_wasm i32) (local $handle i32)
    (local $record i32) (local $i i32) (local $ch i32)
    (local.set $face_guest (call $heap_alloc (i32.const 32)))
    (if (i32.eqz (local.get $face_guest)) (then (return (i32.const 0))))
    (local.set $face_wasm (call $g2w (local.get $face_guest)))
    (memory.fill (local.get $face_wasm) (i32.const 0) (i32.const 32))
    (if (local.get $face)
      (then
        (block $done (loop $copy
          (br_if $done (i32.ge_u (local.get $i) (i32.const 31)))
          (local.set $ch (i32.load8_u
            (i32.add (local.get $face) (local.get $i))))
          (br_if $done (i32.eqz (local.get $ch)))
          (i32.store8 (i32.add (local.get $face_wasm) (local.get $i))
            (local.get $ch))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy)))))
    (local.set $handle (call $gdi_object_alloc (i32.const 4)
      (local.get $height) (local.get $weight)
      (i32.and (local.get $italic) (i32.const 1)) (i32.const 0)))
    (if (i32.eqz (local.get $handle))
      (then
        (call $heap_free (local.get $face_guest))
        (return (i32.const 0))))
    (local.set $record (call $gdi_object_record (local.get $handle)))
    (i32.store offset=28 (local.get $record) (local.get $face_guest))
    (local.get $handle))

  (func $gdi_font_face (param $handle i32) (result i32)
    (local $record i32) (local $face_guest i32)
    (local.set $record (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $record) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $record)) (i32.const 4)))
      (then
        (local.set $face_guest (i32.load offset=28 (local.get $record)))
        (if (local.get $face_guest)
          (then (return (call $g2w (local.get $face_guest)))))))
    (if (i32.eq (local.get $handle) (i32.const 0x3001A))
      (then (return (i32.const 0x07F0A5A0)))) ;; Terminal
    (if (i32.eq (local.get $handle) (i32.const 0x3001B))
      (then (return (i32.const 0x07F0A534)))) ;; Courier
    (if (i32.eq (local.get $handle) (i32.const 0x3001D))
      (then (return (i32.const 0x07F0A520)))) ;; System
    (if (i32.eq (local.get $handle) (i32.const 0x30020))
      (then (return (i32.const 0x07F0A528)))) ;; Fixedsys
    (if (i32.or (i32.eq (local.get $handle) (i32.const 0x30021))
          (i32.eq (local.get $handle) (i32.const 0x30022)))
      (then (return (i32.const 0x07F0A564)))) ;; Tahoma
    (i32.const 0x07F0A53C)) ;; MS Sans Serif/default variable face

  ;; Serialize the actual WAT-owned LOGFONT rather than a provider-side alias.
  (func $gdi_font_write_logfont (param $handle i32) (param $dest i32)
        (param $size i32) (param $wide i32) (result i32)
    (local $required i32) (local $face i32) (local $i i32) (local $ch i32)
    (if (i32.ne (call $gdi_object_type (local.get $handle)) (i32.const 4))
      (then (return (i32.const 0))))
    (local.set $required (select (i32.const 92) (i32.const 60) (local.get $wide)))
    (if (i32.eqz (local.get $dest)) (then (return (local.get $required))))
    (if (i32.lt_u (local.get $size) (local.get $required)) (then (return (i32.const 0))))
    (memory.fill (local.get $dest) (i32.const 0) (local.get $required))
    (i32.store (local.get $dest) (call $gdi_font_height (local.get $handle)))
    (i32.store offset=16 (local.get $dest) (call $gdi_font_weight (local.get $handle)))
    (i32.store8 offset=20 (local.get $dest) (call $gdi_font_italic (local.get $handle)))
    (i32.store8 offset=27 (local.get $dest) (i32.const 0x22))
    (local.set $face (call $gdi_font_face (local.get $handle)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (i32.const 31)))
      (local.set $ch (i32.load8_u (i32.add (local.get $face) (local.get $i))))
      (if (local.get $wide)
        (then (i32.store16 (i32.add (local.get $dest)
          (i32.add (i32.const 28) (i32.shl (local.get $i) (i32.const 1)))) (local.get $ch)))
        (else (i32.store8 (i32.add (local.get $dest)
          (i32.add (i32.const 28) (local.get $i))) (local.get $ch))))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (local.get $required))

  (func $gdi_font_write_text_face (param $hdc i32) (param $count i32)
        (param $dest i32) (param $wide i32) (result i32)
    (local $handle i32) (local $face i32) (local $length i32)
    (local $copy_count i32) (local $i i32) (local $ch i32)
    (local.set $handle (call $gdi_dc_get_field
      (local.get $hdc) (i32.const 88) (i32.const 0x3001D)))
    (local.set $face (call $gdi_font_face (local.get $handle)))
    (block $length_done (loop $length_scan
      (br_if $length_done (i32.ge_u (local.get $length) (i32.const 31)))
      (br_if $length_done (i32.eqz
        (i32.load8_u (i32.add (local.get $face) (local.get $length)))))
      (local.set $length (i32.add (local.get $length) (i32.const 1)))
      (br $length_scan)))
    ;; The sizing form includes the terminator, matching GetTextFace Win32.
    (if (i32.or (i32.eqz (local.get $count)) (i32.eqz (local.get $dest)))
      (then (return (i32.add (local.get $length) (i32.const 1)))))
    (local.set $copy_count (local.get $length))
    (if (i32.ge_u (local.get $copy_count) (local.get $count))
      (then (local.set $copy_count (i32.sub (local.get $count) (i32.const 1)))))
    (block $copy_done (loop $copy
      (br_if $copy_done (i32.ge_u (local.get $i) (local.get $copy_count)))
      (local.set $ch (i32.load8_u (i32.add (local.get $face) (local.get $i))))
      (if (local.get $wide)
        (then (i32.store16 (i32.add (local.get $dest)
          (i32.shl (local.get $i) (i32.const 1))) (local.get $ch)))
        (else (i32.store8 (i32.add (local.get $dest) (local.get $i))
          (local.get $ch))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (if (local.get $wide)
      (then (i32.store16 (i32.add (local.get $dest)
        (i32.shl (local.get $copy_count) (i32.const 1))) (i32.const 0)))
      (else (i32.store8 (i32.add (local.get $dest) (local.get $copy_count))
        (i32.const 0))))
    (local.get $copy_count))

  ;; Serialize the fixed Win32 LOGPEN/LOGBRUSH contracts from canonical WAT
  ;; object records. Extended pens currently expose their base LOGPEN fields;
  ;; user-style arrays are added when their owned storage is implemented.
  (func $gdi_object_write_pen_brush (param $handle i32) (param $dest i32)
        (param $size i32) (result i32)
    (local $record i32) (local $type i32) (local $required i32)
    (local.set $record (call $gdi_object_record (local.get $handle)))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $type (i32.load offset=4 (local.get $record)))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then (local.set $required (i32.const 16)))
      (else (if (i32.eq (local.get $type) (i32.const 2))
        (then (local.set $required (i32.const 12)))
        (else (return (i32.const 0))))))
    (if (i32.eqz (local.get $dest)) (then (return (local.get $required))))
    (if (i32.lt_u (local.get $size) (local.get $required))
      (then (return (i32.const 0))))
    (memory.fill (local.get $dest) (i32.const 0) (local.get $required))
    (i32.store (local.get $dest) (i32.or
      (i32.load offset=8 (local.get $record))
      (i32.and (i32.load offset=20 (local.get $record)) (i32.const 0x000F0F00))))
    (if (i32.eq (local.get $type) (i32.const 1))
      (then
        (i32.store offset=4 (local.get $dest) (i32.load offset=12 (local.get $record)))
        (i32.store offset=12 (local.get $dest) (i32.load offset=16 (local.get $record))))
      (else
        (i32.store offset=4 (local.get $dest) (i32.load offset=16 (local.get $record)))
        (i32.store offset=8 (local.get $dest) (i32.load offset=12 (local.get $record)))))
    (local.get $required))

  (func $gdi_dc_alloc (result i32)
    (local $handle i32) (local $attempts i32)
    ;; DC records are process-shared as well. A worker's stale counter must not
    ;; select its printer bitmap into an active main-thread screen/window DC.
    (block $available (loop $scan
      (if (i32.ge_u (local.get $attempts) (global.get $GDI_DC_STATE_COUNT))
        (then (return (i32.const 0))))
      (local.set $handle (global.get $gdi_next_dc_handle))
      (global.set $gdi_next_dc_handle
        (i32.add (local.get $handle) (i32.const 1)))
      (if (i32.eqz (call $gdi_dc_state_entry (local.get $handle) (i32.const 0)))
        (then (br $available)))
      (local.set $attempts (i32.add (local.get $attempts) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $handle) (i32.const 1)))
      (then (return (i32.const 0))))
    (local.get $handle))

  (func $gdi_dc_delete (param $hdc i32) (result i32)
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
      (then (return (i32.const 0))))
    (call $gdi_dc_clip_release (local.get $hdc))
    (call $gdi_dc_state_release (local.get $hdc))
    (i32.const 1))

  ;; Ensure a screen-sized canonical bitmap/DC for popup menus. Menu layout
  ;; and hit testing use desktop coordinates, so painting through an owning
  ;; window DC would apply its client origin a second time and clip the popup
  ;; at the window boundary. Attachment target zero is the compositor overlay
  ;; presentation; the pixels remain owned and rasterized entirely in WAT.
  (func $gdi_menu_overlay_ensure (result i32)
    (local $wh i32) (local $width i32) (local $height i32)
    (local $bitmap i32) (local $dc i32)
    (local.set $wh (call $host_get_screen_size))
    (local.set $width (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $height (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.or (i32.le_s (local.get $width) (i32.const 0))
          (i32.le_s (local.get $height) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.set $bitmap (global.get $gdi_menu_overlay_bitmap))
    (if (local.get $bitmap)
      (then
        (if (i32.and
              (i32.ne (call $gdi_object_record (local.get $bitmap)) (i32.const 0))
              (i32.and
                (i32.eq (global.get $gdi_menu_overlay_width) (local.get $width))
                (i32.eq (global.get $gdi_menu_overlay_height) (local.get $height))))
          (then
            (drop (call $host_gdi_surface_attach (local.get $bitmap) (i32.const 0)))
            (return (global.get $gdi_menu_overlay_dc))))
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (global.set $gdi_menu_overlay_bitmap (i32.const 0))
        (global.set $gdi_menu_overlay_width (i32.const 0))
        (global.set $gdi_menu_overlay_height (i32.const 0))))
    (local.set $bitmap (call $gdi_create_compat_bitmap_internal
      (local.get $width) (local.get $height) (i32.const 0)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (local.set $dc (global.get $gdi_menu_overlay_dc))
    (if (i32.eqz (local.get $dc))
      (then
        (local.set $dc (call $gdi_dc_alloc))
        (if (i32.eqz (local.get $dc))
          (then
            (drop (call $gdi_object_delete_full (local.get $bitmap)))
            (return (i32.const 0))))
        (global.set $gdi_menu_overlay_dc (local.get $dc))))
    (drop (call $gdi_dc_select_owned_object (local.get $dc) (local.get $bitmap)))
    (global.set $gdi_menu_overlay_bitmap (local.get $bitmap))
    (global.set $gdi_menu_overlay_width (local.get $width))
    (global.set $gdi_menu_overlay_height (local.get $height))
    (if (i32.eqz (call $host_gdi_surface_attach (local.get $bitmap) (i32.const 0)))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (global.set $gdi_menu_overlay_bitmap (i32.const 0))
        (global.set $gdi_menu_overlay_width (i32.const 0))
        (global.set $gdi_menu_overlay_height (i32.const 0))
        (return (i32.const 0))))
    (local.get $dc))

  ;; Bind a host-allocated screen HDC to a persistent canonical bitmap.
  ;; Attach target -1 means the renderer's desktop base presentation.
  (func $gdi_screen_dc_bind (param $hdc i32) (result i32)
    (local $wh i32) (local $width i32) (local $height i32)
    (local $bitmap i32) (local $record i32) (local $bits i32)
    (local.set $wh (call $host_get_screen_size))
    (local.set $width (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $height (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $width)) (i32.eqz (local.get $height)))
      (then (return (i32.const 0))))
    (local.set $bitmap (global.get $gdi_screen_bitmap))
    (if (i32.and (i32.ne (local.get $bitmap) (i32.const 0))
          (i32.or (i32.ne (global.get $gdi_screen_width) (local.get $width))
            (i32.ne (global.get $gdi_screen_height) (local.get $height))))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (global.set $gdi_screen_bitmap (i32.const 0))))
    (local.set $bitmap (global.get $gdi_screen_bitmap))
    (if (i32.eqz (local.get $bitmap))
      (then
        (local.set $bitmap (call $gdi_create_compat_bitmap_internal
          (local.get $width) (local.get $height) (i32.const 0)))
        (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
        (global.set $gdi_screen_bitmap (local.get $bitmap))
        (global.set $gdi_screen_width (local.get $width))
        (global.set $gdi_screen_height (local.get $height))
        ;; COLOR_DESKTOP defaults to RGB(0,128,128), stored as packed raster RGB.
        (local.set $record (call $gdi_object_record (local.get $bitmap)))
        (local.set $bits (i32.load offset=24 (local.get $record)))
        (memory.fill (local.get $bits) (i32.const 0) (i32.mul
          (i32.load offset=28 (local.get $record)) (local.get $height)))
        (local.set $record (i32.const 0))
        (block $fill_done (loop $fill
          (br_if $fill_done (i32.ge_u (local.get $record)
            (i32.mul (local.get $width) (local.get $height))))
          (i32.store (i32.add (local.get $bits) (i32.shl (local.get $record) (i32.const 2)))
            (i32.const 0x00008080))
          (local.set $record (i32.add (local.get $record) (i32.const 1)))
          (br $fill)))))
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
      (then (return (i32.const 0))))
    (drop (call $gdi_dc_select_owned_object (local.get $hdc) (local.get $bitmap)))
    ;; Headless printer DCs have no renderer to attach to; canonical storage is
    ;; still valid and text can use its presentation cache.
    (drop (call $host_gdi_surface_attach (local.get $bitmap) (i32.const -1)))
    (drop (call $host_gdi_surface_upload (local.get $bitmap)
      (i32.const 0) (i32.const 0) (local.get $width) (local.get $height)))
    (i32.const 1))

  (func $gdi_screen_dc_alloc (result i32)
    (local $hdc i32)
    (local.set $hdc (call $gdi_dc_alloc))
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_screen_dc_bind (local.get $hdc)))
      (then
        (drop (call $gdi_dc_delete (local.get $hdc)))
        (return (i32.const 0))))
    (local.get $hdc))

  (func $host_alloc_screen_dc (result i32)
    (call $gdi_screen_dc_alloc))

  (func $gdi_dc_is_screen (param $hdc i32) (result i32)
    (local $bitmap i32) (local $dc i32)
    (local.set $bitmap (global.get $gdi_screen_bitmap))
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.or (i32.eqz (local.get $bitmap)) (i32.eqz (local.get $dc)))
      (then (return (i32.const 0))))
    (i32.eq (i32.load offset=84 (local.get $dc)) (local.get $bitmap)))

  ;; Materialize the global desktop only for APIs that read a screen DC.
  ;; The host walks global z-order and copies canonical surface storage from
  ;; every process directly into this bitmap; Canvas is never sampled.
  (func $gdi_screen_readback_sync (param $hdc i32) (result i32)
    (local $record i32)
    (if (i32.eqz (call $gdi_dc_is_screen (local.get $hdc)))
      (then (return (i32.const 1))))
    (local.set $record (call $gdi_object_record (global.get $gdi_screen_bitmap)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.ne (i32.load offset=16 (local.get $record)) (i32.const 32)))
      (then (return (i32.const 0))))
    (call $host_gdi_screen_readback
      (i32.load offset=24 (local.get $record))
      (i32.load offset=8 (local.get $record))
      (i32.load offset=12 (local.get $record))
      (i32.load offset=28 (local.get $record))))

  (func $gdi_printer_page_clear (param $hdc i32) (result i32)
    (local $record i32) (local $bits i32) (local $bytes i32)
    (if (i32.or
          (i32.ne (local.get $hdc) (global.get $printer_hdc))
          (i32.eqz (global.get $printer_bitmap)))
      (then (return (i32.const 0))))
    (local.set $record (call $gdi_object_record (global.get $printer_bitmap)))
    (if (i32.or (i32.eqz (local.get $record))
          (i32.ne (i32.load offset=4 (local.get $record)) (i32.const 3)))
      (then (return (i32.const 0))))
    (local.set $bits (i32.load offset=24 (local.get $record)))
    (local.set $bytes (i32.mul
      (i32.load offset=28 (local.get $record))
      (i32.load offset=12 (local.get $record))))
    (if (i32.or (i32.eqz (local.get $bits)) (i32.eqz (local.get $bytes)))
      (then (return (i32.const 0))))
    (memory.fill (local.get $bits) (i32.const 0xFF) (local.get $bytes))
    (drop (call $host_gdi_surface_upload (global.get $printer_bitmap)
      (i32.const 0) (i32.const 0) (i32.const 2400) (i32.const 3150)))
    (i32.const 1))

  (func $gdi_printer_dc_release (param $hdc i32) (result i32)
    (local $bitmap i32) (local $released i32)
    (if (i32.or (i32.eqz (local.get $hdc))
          (i32.ne (local.get $hdc) (global.get $printer_hdc)))
      (then (return (i32.const 0))))
    (local.set $bitmap (global.get $printer_bitmap))
    (global.set $printer_hdc (i32.const 0))
    (global.set $printer_bitmap (i32.const 0))
    (global.set $printer_doc_state (i32.const 0))
    (local.set $released (call $gdi_dc_delete (local.get $hdc)))
    (if (local.get $bitmap)
      (then (drop (call $gdi_object_delete_full (local.get $bitmap)))))
    (local.get $released))

  ;; A printer page raster is 2400x3150x4 = 30MB, which is nearly half the DIB
  ;; backing arena. MFC asks for a printer DC during startup purely to measure
  ;; the page (WordPad does this before its window is even up) and usually
  ;; never draws a pixel to it, so allocating the page eagerly cost every such
  ;; app 30MB it never used -- and with a worker thread allocating its own the
  ;; arena had no room left for a screen-sized menu overlay, which is why
  ;; WordPad's menus silently refused to open at large screen sizes.
  ;; The page is created on first use instead; $gdi_dc_bitmap_record is the
  ;; single choke point every draw and every size query already goes through.
  (func $gdi_printer_page_ensure (result i32)
    (local $bitmap i32)
    (if (global.get $printer_bitmap)
      (then (return (global.get $printer_bitmap))))
    (if (i32.eqz (global.get $printer_hdc)) (then (return (i32.const 0))))
    (local.set $bitmap (call $gdi_create_compat_bitmap_internal
      (i32.const 2400) (i32.const 3150) (i32.const 0)))
    (if (i32.eqz (local.get $bitmap)) (then (return (i32.const 0))))
    (if (i32.eq (call $gdi_dc_select_owned_object
          (global.get $printer_hdc) (local.get $bitmap)) (i32.const -1))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (global.set $printer_bitmap (local.get $bitmap))
    (drop (call $gdi_printer_page_clear (global.get $printer_hdc)))
    (local.get $bitmap))

  (func $gdi_printer_dc_alloc (result i32)
    (local $hdc i32)
    (if (global.get $printer_hdc)
      (then (drop (call $gdi_printer_dc_release (global.get $printer_hdc)))))
    (local.set $hdc (call $gdi_dc_alloc))
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    (global.set $printer_hdc (local.get $hdc))
    (global.set $printer_bitmap (i32.const 0))
    (global.set $printer_doc_state (i32.const 0))
    (local.get $hdc))

  (func $gdi_dc_bitmap_record (param $hdc i32) (result i32)
    (local $dc i32) (local $bmp i32)
    ;; First touch of the printer DC materializes its page (see above).
    (if (i32.and
          (i32.and (i32.ne (local.get $hdc) (i32.const 0))
                   (i32.eq (local.get $hdc) (global.get $printer_hdc)))
          (i32.eqz (global.get $printer_bitmap)))
      (then (drop (call $gdi_printer_page_ensure))))
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $bmp (call $gdi_object_record (i32.load offset=84 (local.get $dc))))
    (if (i32.and (i32.ne (local.get $bmp) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $bmp)) (i32.const 3)))
      (then (return (local.get $bmp))))
    (i32.const 0))

  (func $gdi_dc_target_size (param $hdc i32) (result i32)
    (local $bmp i32) (local $dc i32) (local $binding i32) (local $hwnd i32)
    (local $size i32) (local $surface i32)
    (local.set $bmp (call $gdi_dc_bitmap_record (local.get $hdc)))
    (if (local.get $bmp)
      (then (return (i32.or (i32.and (i32.load offset=8 (local.get $bmp)) (i32.const 0xFFFF))
        (i32.shl (i32.and (i32.load offset=12 (local.get $bmp)) (i32.const 0xFFFF))
          (i32.const 16))))))
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $dc)
      (then
        (local.set $binding (i32.load offset=92 (local.get $dc)))
        (local.set $hwnd (i32.and (local.get $binding) (i32.const 0x7FFFFFFF)))
        (if (local.get $hwnd)
          (then
            (if (i32.lt_s (local.get $binding) (i32.const 0))
              (then
                ;; A whole-window DC on a window that owns its surface is
                ;; bounded by that surface, so read the size from the surface
                ;; record itself -- then the clip cannot disagree with what it
                ;; clips. Deriving it from CONTROL_GEOM instead let the two
                ;; drift: Sound Recorder's dialog carried 278x163 against a
                ;; 278x164 surface, and the one-row difference clipped away
                ;; the bottom of its window frame, leaving it with no dark
                ;; bottom edge while the right edge (same DrawEdge call) drew
                ;; fine.
                ;;
                ;; Child whole-window DCs still come from CONTROL_GEOM: they
                ;; draw into their top-level owner's much larger surface, and
                ;; bounding them by it would let a child paint outside itself.
                (if (i32.eq (call $wnd_top_level (local.get $hwnd)) (local.get $hwnd))
                  (then
                    (local.set $surface (call $gdi_window_surface_record
                      (local.get $hwnd) (i32.const 0)))
                    (if (local.get $surface)
                      (then (return (i32.or
                        (i32.and (i32.load offset=8 (local.get $surface)) (i32.const 0xFFFF))
                        (i32.shl
                          (i32.and (i32.load offset=12 (local.get $surface)) (i32.const 0xFFFF))
                          (i32.const 16))))))))
                ;; Without either source a top-level window's finite default
                ;; clip is empty and all WAT nonclient geometry is rejected
                ;; while text still draws.
                (local.set $size (call $ctrl_get_wh_packed (local.get $hwnd)))
                (if (local.get $size) (then (return (local.get $size))))
                (local.set $surface (call $gdi_window_surface_record
                  (call $wnd_top_level (local.get $hwnd)) (i32.const 0)))
                (if (local.get $surface)
                  (then (return (i32.or
                    (i32.and (i32.load offset=8 (local.get $surface)) (i32.const 0xFFFF))
                    (i32.shl
                      (i32.and (i32.load offset=12 (local.get $surface)) (i32.const 0xFFFF))
                      (i32.const 16))))))
                (return (i32.const 0)))
              (else (return (i32.or
                (i32.and (call $wnd_client_w_for_clip (local.get $hwnd)) (i32.const 0xFFFF))
                (i32.shl (i32.and (call $wnd_client_h_for_clip (local.get $hwnd)) (i32.const 0xFFFF))
                  (i32.const 16))))))))))
    (i32.const 0))

  ;; Persistent canonical backing for the top-level window composition target.
  ;; Record: owner hwnd, surface id, width, height, bitsWa, stride, reserved.
  ;; owner 0 is not hinted: the scan answers it with the first empty slot, and
  ;; a hint would name whichever slot went empty most recently instead.
  (global $gdi_window_surface_hint (mut i32) (i32.const 0))
  (func $gdi_window_surface_record (param $owner i32) (param $create i32) (result i32)
    (local $i i32) (local $p i32) (local $empty i32)
    (local.set $p (global.get $gdi_window_surface_hint))
    (if (i32.and (i32.ne (local.get $owner) (i32.const 0))
          (i32.and (i32.ne (local.get $p) (i32.const 0))
            (i32.eq (i32.load (local.get $p)) (local.get $owner))))
      (then (return (local.get $p))))
    (local.set $p (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_WINDOW_SURFACE_COUNT)))
      (local.set $p (i32.add (global.get $GDI_WINDOW_SURFACE_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_WINDOW_SURFACE_STRIDE))))
      (if (i32.eq (i32.load (local.get $p)) (local.get $owner))
        (then
          (if (local.get $owner)
            (then (global.set $gdi_window_surface_hint (local.get $p))))
          (return (local.get $p))))
      (if (i32.and (i32.eqz (local.get $empty)) (i32.eqz (i32.load (local.get $p))))
        (then (local.set $empty (local.get $p))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ne (local.get $create) (i32.const 0))
          (i32.ne (local.get $empty) (i32.const 0)))
      (then
        (i32.store (local.get $empty) (local.get $owner))
        (i32.store offset=4 (local.get $empty)
          (i32.add (i32.const 0x00610001)
            (i32.div_u (i32.sub (local.get $empty) (global.get $GDI_WINDOW_SURFACE_TABLE))
              (global.get $GDI_WINDOW_SURFACE_STRIDE))))
        (return (local.get $empty))))
    (i32.const 0))

  ;; Size of the backing surface for a top-level window.
  ;;
  ;; The window rect comes first because that is the rect everything else
  ;; drawing here agrees on: $defwndproc_do_ncpaint measures the chrome from
  ;; it, and the compositor blits the surface over exactly that area. A
  ;; window's CONTROL_GEOM entry is a second record of the same size and can
  ;; drift from it -- Sound Recorder's dialog carried 278x163 against a
  ;; 278x164 window rect, so the frame's bottom edge was drawn one row past
  ;; the end of a surface sized from CONTROL_GEOM and simply vanished,
  ;; leaving the window with no dark bottom border.
  ;;
  ;; CONTROL_GEOM remains the fallback: during creation a window can have a
  ;; size in WAT before the renderer has a record to report a rect from.
  (func $gdi_window_surface_dimensions (param $owner i32) (result i32)
    (local $wh i32) (local $rect i32) (local $w i32) (local $h i32)
    (local.set $rect (global.get $WINDOW_RECT_SCRATCH))
    (call $host_get_window_rect (local.get $owner) (local.get $rect))
    (local.set $w (i32.sub (i32.load offset=8 (local.get $rect)) (i32.load (local.get $rect))))
    (local.set $h (i32.sub (i32.load offset=12 (local.get $rect)) (i32.load offset=4 (local.get $rect))))
    (if (i32.and (i32.gt_s (local.get $w) (i32.const 0))
          (i32.gt_s (local.get $h) (i32.const 0)))
      (then (return (i32.or (i32.and (local.get $w) (i32.const 0xFFFF))
        (i32.shl (i32.and (local.get $h) (i32.const 0xFFFF)) (i32.const 16))))))
    (local.set $wh (call $ctrl_get_wh_packed (local.get $owner)))
    (local.set $w (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $wh) (i32.const 16)))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0))
          (i32.le_s (local.get $h) (i32.const 0)))
      (then (return (i32.const 0))))
    (local.get $wh))

  (func $gdi_window_surface_ensure (param $hwnd i32) (result i32)
    (local $owner i32) (local $p i32) (local $wh i32) (local $w i32) (local $h i32)
    (local $size64 i64) (local $bits_ga i32) (local $bits i32) (local $id i32)
    (local $had_surface i32)
    (local.set $owner (call $wnd_top_level (local.get $hwnd)))
    (if (i32.eqz (local.get $owner)) (then (local.set $owner (local.get $hwnd))))
    (if (i32.eqz (local.get $owner)) (then (return (i32.const 0))))
    (local.set $wh (call $gdi_window_surface_dimensions (local.get $owner)))
    (local.set $w (i32.and (local.get $wh) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $wh) (i32.const 16)))
    ;; A window with no area still has a device context in Win32 — drawing
    ;; through it is simply clipped away. Refusing one breaks the ordinary
    ;; startup shape of creating a zero-size window, measuring text through
    ;; its DC, and sizing the window from those metrics; an app that reads the
    ;; NULL as fatal destroys itself before it ever paints. Give it a 1x1
    ;; surface instead. The size-change path below reallocates as soon as the
    ;; window gains real dimensions.
    (if (i32.eqz (local.get $w)) (then (local.set $w (i32.const 1))))
    (if (i32.eqz (local.get $h)) (then (local.set $h (i32.const 1))))
    (local.set $p (call $gdi_window_surface_record (local.get $owner) (i32.const 1)))
    (if (i32.eqz (local.get $p)) (then (return (i32.const 0))))
    (local.set $id (i32.load offset=4 (local.get $p)))
    (if (i32.and (i32.eq (i32.load offset=8 (local.get $p)) (local.get $w))
          (i32.eq (i32.load offset=12 (local.get $p)) (local.get $h)))
      (then
        (drop (call $host_gdi_surface_attach (local.get $id) (local.get $owner)))
        (return (local.get $p))))
    ;; Reaching here means the window changed size, so the surface it was
    ;; drawn on is about to be thrown away and replaced with a blank one.
    ;; Everything painted on it goes with it -- including the chrome, which
    ;; unlike the client area nobody repaints on their own: an app redraws its
    ;; client from WM_PAINT, but the caption and frame are ours. Volume Control
    ;; sizes its dialog to the mixer lines it finds, so its window grew once
    ;; after $defwndproc_do_ncpaint had already drawn the title bar, and it
    ;; spent the rest of the session with a blank grey strip where the caption
    ;; had been. Mark the window tree dirty so the NC pass and WM_PAINT run
    ;; again over the new surface.
    (local.set $had_surface (i32.load offset=16 (local.get $p)))
    (if (local.get $had_surface)
      (then
        (drop (call $host_gdi_surface_delete (local.get $id)))
        (call $dib_free_wasm (local.get $had_surface))))
    (local.set $size64 (i64.mul
      (i64.mul (i64.extend_i32_u (local.get $w)) (i64.extend_i32_u (local.get $h)))
      (i64.const 4)))
    (if (i64.gt_u (local.get $size64) (i64.extend_i32_u (global.get $DIB_BACKING_BASE_SIZE)))
      (then (return (i32.const 0))))
    (local.set $bits_ga (call $dib_alloc (i32.wrap_i64 (local.get $size64))))
    (if (i32.eqz (local.get $bits_ga)) (then (return (i32.const 0))))
    (local.set $bits (call $g2w (local.get $bits_ga)))
    (i32.store offset=8 (local.get $p) (local.get $w))
    (i32.store offset=12 (local.get $p) (local.get $h))
    (i32.store offset=16 (local.get $p) (local.get $bits))
    (i32.store offset=20 (local.get $p) (i32.mul (local.get $w) (i32.const 4)))
    (if (i32.eqz (call $host_gdi_surface_create
          (local.get $id) (local.get $w) (local.get $h) (i32.const 32)
          (local.get $bits) (i32.load offset=20 (local.get $p)) (i32.const 1)
          (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0)))
      (then
        (call $dib_free_wasm (local.get $bits))
        (i32.store offset=8 (local.get $p) (i32.const 0))
        (i32.store offset=12 (local.get $p) (i32.const 0))
        (i32.store offset=16 (local.get $p) (i32.const 0))
        (return (i32.const 0))))
    (if (i32.eqz (call $host_gdi_surface_attach (local.get $id) (local.get $owner)))
      (then
        (drop (call $host_gdi_surface_delete (local.get $id)))
        (call $dib_free_wasm (local.get $bits))
        (i32.store offset=8 (local.get $p) (i32.const 0))
        (i32.store offset=12 (local.get $p) (i32.const 0))
        (i32.store offset=16 (local.get $p) (i32.const 0))
        (return (i32.const 0))))
    (if (i32.and (i32.ne (local.get $had_surface) (i32.const 0))
          (i32.eqz (global.get $gdi_surface_resize_repaint)))
      (then
        ;; Draw the chrome straight back on rather than only queueing
        ;; WM_NCPAINT: a window's nonclient area is repainted by its
        ;; DefWindowProc, and an app whose window procedure answers
        ;; WM_NCPAINT itself never lets it run. Volume Control is one, so a
        ;; queued repaint left its caption a blank grey strip for the rest of
        ;; the session. The guard stops the recursion through
        ;; $host_alloc_window_dc, which lands back here -- by now the record
        ;; carries the new size, so the nested call returns at the size check.
        (global.set $gdi_surface_resize_repaint (i32.const 1))
        (call $defwndproc_do_ncpaint (local.get $owner))
        (global.set $gdi_surface_resize_repaint (i32.const 0))
        ;; The client area was on that surface too. Its owner does repaint
        ;; that itself, once it knows there is something to repaint.
        (call $paint_mark_visible_tree (local.get $owner))))
    (local.get $p))

  (func $gdi_window_surface_release (param $hwnd i32)
    (local $p i32)
    (local.set $p (call $gdi_window_surface_record (local.get $hwnd) (i32.const 0)))
    (if (local.get $p)
      (then
        (drop (call $host_gdi_surface_delete (i32.load offset=4 (local.get $p))))
        (if (i32.load offset=16 (local.get $p))
          (then (call $dib_free_wasm (i32.load offset=16 (local.get $p)))))
        (memory.fill (local.get $p) (i32.const 0) (global.get $GDI_WINDOW_SURFACE_STRIDE)))))

  (func $gdi_window_dc_bind (param $hdc i32) (param $hwnd i32) (param $whole i32) (result i32)
    (local $dc i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (i32.store offset=92 (local.get $dc)
      (i32.or (i32.and (local.get $hwnd) (i32.const 0x7FFFFFFF))
        (select (i32.const 0x80000000) (i32.const 0)
          (i32.ne (local.get $whole) (i32.const 0)))))
    (i32.ne (call $gdi_window_surface_ensure (local.get $hwnd)) (i32.const 0)))

  ;; DirectDraw HDCs address native DX_OBJECTS pixel storage directly. The
  ;; host surface registered here is only a derived presentation cache.
  (func $gdi_dx_surface_entry (param $hdc i32) (result i32)
    (local $slot i32) (local $entry i32)
    (if (i32.or (i32.lt_u (local.get $hdc) (i32.const 0x00200000))
          (i32.ge_u (local.get $hdc) (i32.const 0x00300000)))
      (then (return (i32.const 0))))
    (local.set $slot (i32.sub (local.get $hdc) (i32.const 0x00200000)))
    (if (i32.ge_u (local.get $slot) (global.get $DX_MAX))
      (then (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $DX_OBJECTS)
      (i32.mul (local.get $slot) (global.get $DX_ENTRY_SIZE))))
    (if (i32.ne (i32.load (local.get $entry)) (i32.const 2))
      (then (return (i32.const 0))))
    (local.get $entry))

  (func $gdi_dx_dc_bind (param $hdc i32) (result i32)
    (local $entry i32) (local $bpp i32) (local $palette i32) (local $count i32)
    (local.set $entry (call $gdi_dx_surface_entry (local.get $hdc)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
      (then (return (i32.const 0))))
    (local.set $bpp (i32.load16_u offset=16 (local.get $entry)))
    (if (i32.le_u (local.get $bpp) (i32.const 8))
      (then
        (local.set $palette (global.get $dx_primary_pal_wa))
        (if (local.get $palette) (then (local.set $count (i32.const 256))))))
    (call $host_gdi_surface_create
      (local.get $hdc)
      (i32.load16_u offset=12 (local.get $entry))
      (i32.load16_u offset=14 (local.get $entry))
      (local.get $bpp)
      (i32.load offset=20 (local.get $entry))
      (i32.load16_u offset=18 (local.get $entry))
      (i32.const 1) (local.get $palette) (local.get $count)
      (select (i32.const 0xF800) (i32.const 0)
        (i32.eq (local.get $bpp) (i32.const 16)))
      (select (i32.const 0x07E0) (i32.const 0)
        (i32.eq (local.get $bpp) (i32.const 16)))
      (select (i32.const 0x001F) (i32.const 0)
        (i32.eq (local.get $bpp) (i32.const 16)))))

  (func $gdi_dx_dc_release (param $hdc i32)
    (call $gdi_dc_clip_release (local.get $hdc))
    (call $gdi_dc_state_release (local.get $hdc))
    (drop (call $host_gdi_surface_delete (local.get $hdc))))

  (func $host_alloc_window_dc (param $hwnd i32) (param $whole i32) (result i32)
    (local $hdc i32) (local $own i32)
    ;; A CS_OWNDC window is handed the same DC every time, so that whatever it
    ;; selected in stays selected. Client DCs only: GetWindowDC and the
    ;; nonclient chrome ask for a different region of the surface and get
    ;; their own DC, as they do on Windows.
    (if (i32.eqz (local.get $whole))
      (then (local.set $own (call $wnd_get_own_dc (local.get $hwnd)))))
    (if (i32.gt_s (local.get $own) (i32.const 0))
      (then
        ;; Rebind rather than assume: the window may have been resized and its
        ;; surface remade since the last acquisition. The bind touches only the
        ;; owner field and the surface, never the selected objects. The clip is
        ;; per-acquisition — BeginPaint intersects the update rect into it — so
        ;; it starts each time from the same empty state a fresh DC would have.
        (if (call $gdi_window_dc_bind (local.get $own) (local.get $hwnd) (i32.const 0))
          (then
            (call $gdi_dc_clip_release (local.get $own))
            (call $gdi_dc_aux_release (local.get $own))
            (return (local.get $own))))
        (return (i32.const 0))))
    (local.set $hdc (call $gdi_dc_alloc))
    (if (local.get $hdc)
      (then
        (if (i32.eqz (call $gdi_window_dc_bind
              (local.get $hdc) (local.get $hwnd) (local.get $whole)))
          (then
            (drop (call $gdi_dc_delete (local.get $hdc)))
            (local.set $hdc (i32.const 0)))
          (else
            (if (i32.lt_s (local.get $own) (i32.const 0))
              (then (call $wnd_set_own_dc (local.get $hwnd) (local.get $hdc))))))))
    (local.get $hdc))

  (func $host_release_dc (param $hdc i32) (result i32)
    ;; A private DC survives ReleaseDC and EndPaint — that is what makes its
    ;; selected objects persist. Its clip and aux scratch are per-acquisition
    ;; and still go; only the state record, which holds the selections, stays.
    (if (call $wnd_own_dc_is_private (local.get $hdc))
      (then
        (call $gdi_dc_aux_release (local.get $hdc))
        (call $gdi_dc_clip_release (local.get $hdc))
        (return (i32.const 1))))
    (call $gdi_dc_aux_release (local.get $hdc))
    (call $gdi_dc_clip_release (local.get $hdc))
    (call $gdi_dc_state_release (local.get $hdc))
    (i32.const 1))

  (func $host_gdi_set_text_color (param $hdc i32) (param $color i32) (result i32)
    (call $gdi_dc_set_field (local.get $hdc) (i32.const 20)
      (i32.and (local.get $color) (i32.const 0xFFFFFF)) (i32.const 0)))
  (func $host_gdi_get_text_color (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 20) (i32.const 0)))
  (func $host_gdi_set_bk_color (param $hdc i32) (param $color i32) (result i32)
    (call $gdi_dc_set_field (local.get $hdc) (i32.const 24)
      (i32.and (local.get $color) (i32.const 0xFFFFFF)) (i32.const 0xFFFFFF)))
  (func $host_gdi_get_bk_color (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 24) (i32.const 0xFFFFFF)))
  (func $host_gdi_set_bk_mode (param $hdc i32) (param $mode i32) (result i32)
    (if (i32.or (i32.eq (local.get $mode) (i32.const 1))
          (i32.eq (local.get $mode) (i32.const 2)))
      (then (return (call $gdi_dc_set_field (local.get $hdc) (i32.const 28)
        (local.get $mode) (i32.const 2)))))
    (i32.const 0))
  (func $host_gdi_get_bk_mode (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 28) (i32.const 2)))
  (func $host_gdi_set_text_align (param $hdc i32) (param $align i32) (result i32)
    (call $gdi_dc_set_field (local.get $hdc) (i32.const 32) (local.get $align) (i32.const 0)))
  (func $host_gdi_get_text_align (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 32) (i32.const 0)))

  ;; Every text call now ends in the strike rasterizer. A negative result means
  ;; no strike could be selected at all — no DC, or the bundled MS Sans Serif
  ;; .FON failed to load — and with no host font path left underneath, the
  ;; honest answer to "draw this" is that nothing was drawn.
  (func $host_gdi_text_out (param $hdc i32) (param $x i32) (param $y i32)
        (param $text i32) (param $count i32) (param $wide i32) (result i32)
    (local $bitmap_result i32)
    (local.set $bitmap_result (call $gdi_bitmap_text_out
      (local.get $hdc) (local.get $x) (local.get $y) (i32.const 0) (i32.const 0)
      (local.get $text) (local.get $count) (i32.const 0) (local.get $wide)))
    (select (local.get $bitmap_result) (i32.const 0)
      (i32.ge_s (local.get $bitmap_result) (i32.const 0))))

  ;; Windows 98 lays a string out as a run of whole-pixel advances: GDI applies
  ;; no kerning and accumulates nothing fractional, so the extent of a string is
  ;; exactly the sum of the advances GetCharWidth reports for its characters.
  ;; The strike rasterizer sums per-glyph advances directly, which is why both
  ;; of these are now thin wrappers over it.
  (func $host_measure_text (param $hdc i32) (param $text i32)
        (param $count i32) (param $wide i32) (result i32)
    (local $bitmap_result i32)
    (if (i32.le_s (local.get $count) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $bitmap_result (call $gdi_bitmap_text_measure
      (local.get $hdc) (local.get $text) (local.get $count) (local.get $wide)))
    (select (local.get $bitmap_result) (i32.const 0)
      (i32.ge_s (local.get $bitmap_result) (i32.const 0))))

  (func $host_get_text_metrics (param $hdc i32) (result i32)
    (local $bitmap_result i32)
    (local.set $bitmap_result (call $gdi_bitmap_text_metrics (local.get $hdc)))
    (select (local.get $bitmap_result) (i32.const 0)
      (i32.ge_s (local.get $bitmap_result) (i32.const 0))))

  ;; The selected WAT strike supplies glyph measurement. Prefix fitting and
  ;; Win32 output structures share the same state for ANSI and UTF-16 calls.
  (func $gdi_text_extent_ex (param $hdc i32) (param $text i32)
        (param $count i32) (param $max_extent i32) (param $fit i32)
        (param $dx i32) (param $size i32) (param $wide i32) (result i32)
    (local $metrics i32) (local $height i32) (local $i i32)
    (local $width i32) (local $fit_count i32)
    (if (i32.or (i32.eqz (local.get $size))
          (i32.or (i32.lt_s (local.get $count) (i32.const 0))
            (i32.or (i32.gt_u (local.get $count) (i32.const 65536))
              (i32.and (i32.gt_s (local.get $count) (i32.const 0))
                (i32.eqz (local.get $text))))))
      (then (return (i32.const 0))))
    (local.set $metrics (call $host_get_text_metrics (local.get $hdc)))
    (if (i32.eqz (local.get $metrics)) (then (return (i32.const 0))))
    (local.set $height (i32.and (local.get $metrics) (i32.const 0xFFFF)))
    ;; One advance per character, accumulated — the same arithmetic Windows 98
    ;; does, and the same arithmetic GetCharWidth reports one entry at a time.
    ;; Measuring each prefix from scratch instead would ask the font provider
    ;; n(n+1)/2 questions to answer n of them.
    (block $done (loop $prefix
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $width (i32.add (local.get $width)
        (call $gdi_font_character_width (local.get $hdc)
          (if (result i32) (local.get $wide)
            (then (i32.load16_u (i32.add (local.get $text)
              (i32.shl (local.get $i) (i32.const 1)))))
            (else (i32.load8_u (i32.add (local.get $text) (local.get $i)))))
          (local.get $wide))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (if (local.get $dx)
        (then (i32.store (i32.add (local.get $dx)
          (i32.shl (i32.sub (local.get $i) (i32.const 1)) (i32.const 2)))
          (local.get $width))))
      (if (i32.le_s (local.get $width) (local.get $max_extent))
        (then (local.set $fit_count (local.get $i))))
      (br $prefix)))
    (if (local.get $fit) (then (i32.store (local.get $fit) (local.get $fit_count))))
    (i32.store (local.get $size) (local.get $width))
    (i32.store offset=4 (local.get $size) (local.get $height))
    (i32.const 1))

  (func $gdi_char_abc_widths_a (param $hdc i32) (param $first i32)
        (param $last i32) (param $out i32) (result i32)
    (local $ch i32) (local $index i32) (local $width i32) (local $entry i32)
    (if (i32.or (i32.eqz (local.get $out))
          (i32.or (i32.gt_u (local.get $first) (local.get $last))
            (i32.gt_u (i32.sub (local.get $last) (local.get $first)) (i32.const 255))))
      (then (return (i32.const 0))))
    (local.set $ch (local.get $first))
    (block $done (loop $characters
      (br_if $done (i32.gt_u (local.get $ch) (local.get $last)))
      (i32.store8 (global.get $TEXT_SCRATCH) (local.get $ch))
      (i32.store8 offset=1 (global.get $TEXT_SCRATCH) (i32.const 0))
      (local.set $width (call $host_measure_text (local.get $hdc)
        (global.get $TEXT_SCRATCH) (i32.const 1) (i32.const 0)))
      (local.set $entry (i32.add (local.get $out)
        (i32.mul (local.get $index) (i32.const 12))))
      (i32.store (local.get $entry) (i32.const 0))
      (i32.store offset=4 (local.get $entry) (local.get $width))
      (i32.store offset=8 (local.get $entry) (i32.const 0))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (local.set $ch (i32.add (local.get $ch) (i32.const 1)))
      (br $characters)))
    (i32.const 1))

  (func $gdi_glyph_metrics_a (param $hdc i32) (param $character i32)
        (param $format i32) (param $metrics_out i32) (result i32)
    (local $packed i32) (local $height i32) (local $width i32)
    (if (i32.or (i32.ne (local.get $format) (i32.const 0))
          (i32.eqz (local.get $metrics_out)))
      (then (return (i32.const -1))))
    (i32.store8 (global.get $TEXT_SCRATCH) (local.get $character))
    (i32.store8 offset=1 (global.get $TEXT_SCRATCH) (i32.const 0))
    (local.set $width (call $host_measure_text (local.get $hdc)
      (global.get $TEXT_SCRATCH) (i32.const 1) (i32.const 0)))
    (local.set $packed (call $host_get_text_metrics (local.get $hdc)))
    (if (i32.eqz (local.get $packed)) (then (return (i32.const -1))))
    (local.set $height (i32.and (local.get $packed) (i32.const 0xFFFF)))
    (i32.store (local.get $metrics_out) (local.get $width))
    (i32.store offset=4 (local.get $metrics_out) (local.get $height))
    (i32.store offset=8 (local.get $metrics_out) (i32.const 0))
    (i32.store offset=12 (local.get $metrics_out) (local.get $height))
    (i32.store16 offset=16 (local.get $metrics_out) (local.get $width))
    (i32.store16 offset=18 (local.get $metrics_out) (i32.const 0))
    (i32.const 0))

  ;; Measure and optionally draw a tabbed string. WAT owns character parsing,
  ;; explicit/default tab-stop selection and packed SIZE construction; Canvas
  ;; only measures/rasterizes individual non-tab text runs.
  (func $gdi_tabbed_text (param $hdc i32) (param $x i32) (param $y i32)
        (param $text_g i32) (param $count i32) (param $tab_count i32)
        (param $stops_g i32) (param $origin i32) (param $wide i32)
        (param $draw i32) (result i32)
    (local $text i32) (local $stops i32) (local $metrics i32)
    (local $height i32) (local $average i32) (local $default_tab i32)
    (local $i i32) (local $run_start i32) (local $run_count i32)
    (local $cursor i32) (local $run_width i32) (local $ch i32)
    (local $tab_i i32) (local $next i32) (local $relative i32)
    (local $align i32)
    (if (i32.or (i32.lt_s (local.get $count) (i32.const 0))
          (i32.or (i32.lt_s (local.get $tab_count) (i32.const 0))
            (i32.and (i32.gt_s (local.get $count) (i32.const 0))
              (i32.eqz (local.get $text_g)))))
      (then (return (i32.const 0))))
    (if (i32.and (i32.gt_s (local.get $tab_count) (i32.const 0))
          (i32.eqz (local.get $stops_g)))
      (then (return (i32.const 0))))
    (if (local.get $text_g) (then (local.set $text (call $g2w (local.get $text_g)))))
    (if (local.get $stops_g) (then (local.set $stops (call $g2w (local.get $stops_g)))))
    (local.set $metrics (call $host_get_text_metrics (local.get $hdc)))
    (local.set $height (i32.and (local.get $metrics) (i32.const 0xFFFF)))
    (local.set $average (i32.shr_u (local.get $metrics) (i32.const 16)))
    (if (i32.eqz (local.get $height)) (then (local.set $height (i32.const 13))))
    (if (i32.eqz (local.get $average)) (then (local.set $average (i32.const 8))))
    (local.set $default_tab (i32.mul (local.get $average) (i32.const 8)))
    (local.set $align (call $gdi_dc_get_field
      (local.get $hdc) (i32.const 32) (i32.const 0)))
    (if (i32.and (local.get $draw) (i32.and (local.get $align) (i32.const 1)))
      (then
        (local.set $x (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 12) (i32.const 0)))
        (local.set $y (call $gdi_dc_get_field
          (local.get $hdc) (i32.const 16) (i32.const 0)))))
    (local.set $cursor (local.get $x))
    (local.set $run_start (i32.const 0))
    (block $done (loop $scan
      (if (i32.lt_s (local.get $i) (local.get $count))
        (then
          (local.set $ch
            (if (result i32) (local.get $wide)
              (then (i32.load16_u (i32.add (local.get $text)
                (i32.shl (local.get $i) (i32.const 1)))))
              (else (i32.load8_u (i32.add (local.get $text) (local.get $i))))))
          (if (i32.ne (local.get $ch) (i32.const 9))
            (then
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $scan)))))
      (local.set $run_count (i32.sub (local.get $i) (local.get $run_start)))
      (if (i32.gt_s (local.get $run_count) (i32.const 0))
        (then
          (local.set $run_width (call $host_measure_text
            (local.get $hdc)
            (i32.add (local.get $text)
              (select (i32.shl (local.get $run_start) (i32.const 1))
                (local.get $run_start) (local.get $wide)))
            (local.get $run_count) (local.get $wide)))
          (if (local.get $draw)
            (then (drop (call $host_gdi_text_out
              (local.get $hdc) (local.get $cursor) (local.get $y)
              (i32.add (local.get $text)
                (select (i32.shl (local.get $run_start) (i32.const 1))
                  (local.get $run_start) (local.get $wide)))
              (local.get $run_count) (local.get $wide)))))
          (local.set $cursor (i32.add (local.get $cursor) (local.get $run_width)))))
      (br_if $done (i32.ge_s (local.get $i) (local.get $count)))
      ;; A tab advances to the first explicit stop strictly right of the
      ;; current position. Without usable explicit stops, repeat the Win32
      ;; default interval of eight average character cells from tab origin.
      (local.set $relative (i32.sub (local.get $cursor) (local.get $origin)))
      (local.set $next (i32.const 0x7FFFFFFF))
      (if (i32.eq (local.get $tab_count) (i32.const 1))
        (then
          (local.set $ch (i32.load (local.get $stops)))
          (if (i32.gt_s (local.get $ch) (i32.const 0))
            (then (local.set $next (i32.mul
              (i32.add (i32.div_s (select (local.get $relative) (i32.const 0)
                  (i32.gt_s (local.get $relative) (i32.const 0)))
                (local.get $ch)) (i32.const 1))
              (local.get $ch))))))
        (else
          (local.set $tab_i (i32.const 0))
          (block $stops_done (loop $stops_loop
            (br_if $stops_done (i32.ge_s (local.get $tab_i) (local.get $tab_count)))
            (local.set $ch (i32.load (i32.add (local.get $stops)
              (i32.shl (local.get $tab_i) (i32.const 2)))))
            (if (i32.and (i32.gt_s (local.get $ch) (local.get $relative))
                  (i32.lt_s (local.get $ch) (local.get $next)))
              (then (local.set $next (local.get $ch))))
            (local.set $tab_i (i32.add (local.get $tab_i) (i32.const 1)))
            (br $stops_loop)))))
      (if (i32.eq (local.get $next) (i32.const 0x7FFFFFFF))
        (then
          (local.set $next (i32.mul
            (i32.add (i32.div_s (select (local.get $relative) (i32.const 0)
                (i32.gt_s (local.get $relative) (i32.const 0)))
              (local.get $default_tab)) (i32.const 1))
            (local.get $default_tab)))))
      (local.set $cursor (i32.add (local.get $origin) (local.get $next)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $run_start (local.get $i))
      (br $scan)))
    (if (i32.and (local.get $draw) (i32.and (local.get $align) (i32.const 1)))
      (then
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
          (local.get $cursor) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
          (local.get $y) (i32.const 0)))))
    (i32.or (i32.and (i32.sub (local.get $cursor) (local.get $x)) (i32.const 0xFFFF))
      (i32.shl (i32.and (local.get $height) (i32.const 0xFFFF)) (i32.const 16))))
  (func $host_gdi_ext_text_out (param $hdc i32) (param $x i32) (param $y i32)
        (param $options i32) (param $rect i32) (param $text i32) (param $count i32)
        (param $dx_array i32) (param $wide i32) (result i32)
    (local $bitmap_result i32)
    (local.set $bitmap_result (call $gdi_bitmap_text_out
      (local.get $hdc) (local.get $x) (local.get $y)
      (local.get $options) (local.get $rect) (local.get $text)
      (local.get $count) (local.get $dx_array) (local.get $wide)))
    (select (local.get $bitmap_result) (i32.const 0)
      (i32.ge_s (local.get $bitmap_result) (i32.const 0))))
  (func $host_gdi_draw_text (param $hdc i32) (param $text i32) (param $count i32)
        (param $rect i32) (param $format i32) (param $wide i32) (result i32)
    (call $gdi_bitmap_draw_text
      (local.get $hdc) (local.get $text) (local.get $count)
      (local.get $rect) (local.get $format) (local.get $wide)))

  (func $gdi_surface_descriptor (param $hdc i32) (param $desc i32) (result i32)
    (local $dc i32) (local $bmp i32) (local $surface i32) (local $pen i32) (local $pen_handle i32)
    (local $pen_width i32) (local $pen_color i32) (local $pen_style i32)
    (local $wide i32) (local $binding i32) (local $hwnd i32) (local $owner i32)
    (local $bits i32) (local $width i32) (local $height i32) (local $stride i32) (local $dx i32)
    (local $bpp i32) (local $top_down i32) (local $surface_id i32)
    (local $origin_x i32) (local $origin_y i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    ;; Screen drawing and reading both start from the current global desktop.
    ;; The host-side signature makes this a no-copy check until scene pixels or
    ;; layout change, while preserving direct screen writes above that base.
    (if (i32.and (i32.ne (global.get $gdi_screen_bitmap) (i32.const 0))
          (i32.eq (i32.load offset=84 (local.get $dc))
            (global.get $gdi_screen_bitmap)))
      (then
        (if (i32.eqz (call $gdi_screen_readback_sync (local.get $hdc)))
          (then (return (i32.const 0))))))
    (local.set $dx (call $gdi_dx_surface_entry (local.get $hdc)))
    (local.set $bmp (call $gdi_dc_bitmap_record (local.get $hdc)))
    (if (local.get $dx)
      (then
        (local.set $bits (i32.load offset=20 (local.get $dx)))
        (local.set $width (i32.load16_u offset=12 (local.get $dx)))
        (local.set $height (i32.load16_u offset=14 (local.get $dx)))
        (local.set $stride (i32.load16_u offset=18 (local.get $dx)))
        (local.set $bpp (i32.load16_u offset=16 (local.get $dx)))
        (local.set $top_down (i32.const 1))
        (local.set $surface_id (local.get $hdc)))
      (else
        (if (local.get $bmp)
          (then
            (local.set $bits (i32.load offset=24 (local.get $bmp)))
            (local.set $width (i32.load offset=8 (local.get $bmp)))
            (local.set $height (i32.load offset=12 (local.get $bmp)))
            (local.set $stride (i32.load offset=28 (local.get $bmp)))
            (local.set $bpp (i32.load offset=16 (local.get $bmp)))
            (local.set $top_down
              (i32.and (i32.shr_u (i32.load offset=20 (local.get $bmp)) (i32.const 1)) (i32.const 1)))
            (local.set $surface_id (i32.load offset=40 (local.get $bmp))))
          (else
            (local.set $binding (i32.load offset=92 (local.get $dc)))
            (local.set $hwnd (i32.and (local.get $binding) (i32.const 0x7FFFFFFF)))
            (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
            (local.set $surface (call $gdi_window_surface_ensure (local.get $hwnd)))
            (if (i32.eqz (local.get $surface)) (then (return (i32.const 0))))
            (local.set $owner (i32.load (local.get $surface)))
            (local.set $bits (i32.load offset=16 (local.get $surface)))
            (local.set $width (i32.load offset=8 (local.get $surface)))
            (local.set $height (i32.load offset=12 (local.get $surface)))
            (local.set $stride (i32.load offset=20 (local.get $surface)))
            (local.set $bpp (i32.const 32))
            (local.set $top_down (i32.const 1))
            (local.set $surface_id (i32.load offset=4 (local.get $surface)))
            (if (i32.lt_s (local.get $binding) (i32.const 0))
              (then
                (local.set $origin_x (i32.sub
                  (call $wnd_window_screen_x (local.get $hwnd))
                  (call $wnd_window_screen_x (local.get $owner))))
                (local.set $origin_y (i32.sub
                  (call $wnd_window_screen_y (local.get $hwnd))
                  (call $wnd_window_screen_y (local.get $owner)))))
              (else
                (local.set $origin_x (i32.sub
                  (call $wnd_client_screen_x (local.get $hwnd))
                  (call $wnd_window_screen_x (local.get $owner))))
                (local.set $origin_y (i32.sub
                  (call $wnd_client_screen_y (local.get $hwnd))
                  (call $wnd_window_screen_y (local.get $owner))))))))))
    (local.set $pen_handle (i32.load offset=4 (local.get $dc)))
    (if (i32.eq (local.get $pen_handle) (i32.const 0x30018))
      (then (local.set $pen_style (i32.const 5))))
    (local.set $pen (call $gdi_object_record (local.get $pen_handle)))
    (local.set $pen_width (i32.const 1))
    (if (local.get $pen)
      (then
        (local.set $pen_style (i32.load offset=8 (local.get $pen)))
        (local.set $pen_width (i32.load offset=12 (local.get $pen)))
        (local.set $pen_color (i32.load offset=16 (local.get $pen)))
        (if (i32.ne (i32.and (i32.load offset=20 (local.get $pen)) (i32.const 1)) (i32.const 0))
          (then (local.set $pen_style (i32.const 5))))))
    (if (i32.eqz (local.get $pen_width))
      (then (local.set $pen_width (i32.const 1))))
    (local.set $wide (i32.gt_s (local.get $pen_width) (i32.const 1)))
    (i32.store (local.get $desc) (local.get $bits))
    (i32.store offset=4 (local.get $desc) (local.get $width))
    (i32.store offset=8 (local.get $desc) (local.get $height))
    (i32.store offset=12 (local.get $desc) (local.get $stride))
    (i32.store offset=16 (local.get $desc) (local.get $bpp))
    (i32.store offset=20 (local.get $desc) (local.get $top_down))
    (i32.store offset=24 (local.get $desc) (local.get $pen_color))
    (i32.store offset=28 (local.get $desc) (local.get $pen_width))
    (i32.store offset=32 (local.get $desc) (i32.load offset=40 (local.get $dc)))
    (i32.store offset=36 (local.get $desc) (i32.load offset=44 (local.get $dc)))
    (i32.store offset=40 (local.get $desc) (i32.load offset=48 (local.get $dc)))
    (i32.store offset=44 (local.get $desc) (i32.load offset=52 (local.get $dc)))
    (i32.store offset=48 (local.get $desc) (i32.load offset=56 (local.get $dc)))
    (i32.store offset=52 (local.get $desc) (i32.load offset=60 (local.get $dc)))
    (i32.store offset=56 (local.get $desc) (i32.load offset=64 (local.get $dc)))
    (i32.store offset=60 (local.get $desc) (i32.load offset=68 (local.get $dc)))
    ;; Win98 geometric pens normalize the basic dash styles to a solid wide
    ;; footprint. Thin cosmetic pens retain their style for WAT dash stepping.
    (i32.store offset=64 (local.get $desc)
      (select (i32.const 0) (local.get $pen_style) (local.get $wide)))
    (i32.store offset=68 (local.get $desc) (local.get $surface_id))
    (i32.store offset=72 (local.get $desc) (local.get $origin_x))
    (i32.store offset=76 (local.get $desc) (local.get $origin_y))
    (i32.const 1))

  (func $gdi_line_descriptor_supported (param $desc i32) (result i32)
    (local $style i32) (local $width i32) (local $unit_mapping i32)
    (if (i32.and (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 16))
          (i32.and
            (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 24))
            (i32.ne (i32.load offset=16 (local.get $desc)) (i32.const 32))))
      (then (return (i32.const 0))))
    (local.set $style (i32.load offset=64 (local.get $desc)))
    (local.set $width (i32.load offset=28 (local.get $desc)))
    (if (i32.or
          (i32.or (i32.eq (local.get $style) (i32.const 5))
            (i32.and (i32.or (i32.lt_s (local.get $style) (i32.const 0))
              (i32.gt_s (local.get $style) (i32.const 4)))
              (i32.ne (local.get $style) (i32.const 6))))
          (i32.or (i32.lt_s (local.get $width) (i32.const 1))
            (i32.gt_s (local.get $width) (i32.const 64))))
      (then (return (i32.const 0))))
    (local.set $unit_mapping
      (i32.and
        (i32.or
          (i32.eq (i32.load offset=40 (local.get $desc)) (i32.load offset=56 (local.get $desc)))
          (i32.eq (i32.load offset=40 (local.get $desc))
            (i32.sub (i32.const 0) (i32.load offset=56 (local.get $desc)))))
        (i32.or
          (i32.eq (i32.load offset=44 (local.get $desc)) (i32.load offset=60 (local.get $desc)))
          (i32.eq (i32.load offset=44 (local.get $desc))
            (i32.sub (i32.const 0) (i32.load offset=60 (local.get $desc)))))))
    (if (i32.and (i32.gt_s (local.get $width) (i32.const 1))
          (i32.eqz (local.get $unit_mapping)))
      (then (return (i32.const 0))))
    (i32.const 1))

  (func $gdi_dc_state_release (param $hdc i32)
    (local $entry i32) (local $color i32)
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (local.get $entry)
      (then
        (local.set $color (i32.add (global.get $GDI_COLOR_ADJUST_TABLE)
          (i32.div_u (i32.mul
            (i32.sub (local.get $entry) (global.get $GDI_DC_STATE_TABLE)) (i32.const 24))
            (global.get $GDI_DC_STATE_STRIDE))))
        (memory.fill (local.get $color) (i32.const 0) (i32.const 24))))
    (if (local.get $entry)
      (then (memory.fill (local.get $entry) (i32.const 0) (global.get $GDI_DC_STATE_STRIDE))))
    (call $gdi_dc_aux_release (local.get $hdc))
    (call $gdi_dc_path_release (local.get $hdc))
    (call $gdi_dc_meta_release (local.get $hdc)))

  ;; ---- WAT software line rasterization --------------------------------
  ;; ROP2 is part of the canonical DC record. Descriptor fields are
  ;; documented at the host import.

  (func $gdi_dc_get_rop2 (param $hdc i32) (result i32)
    (call $gdi_dc_get_field (local.get $hdc) (i32.const 72) (i32.const 13)))

  (func $gdi_dc_set_rop2 (param $hdc i32) (param $rop2 i32) (result i32)
    (local $entry i32) (local $old i32)
    (if (i32.or (i32.lt_u (local.get $rop2) (i32.const 1))
          (i32.gt_u (local.get $rop2) (i32.const 16)))
      (then (return (i32.const 0))))
    (local.set $entry (call $gdi_dc_state_entry (local.get $hdc) (i32.const 1)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $old (i32.load offset=72 (local.get $entry)))
    (i32.store offset=72 (local.get $entry) (local.get $rop2))
    (local.get $old))
