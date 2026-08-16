  ;; ---- Win16/Win9x bitmap fonts ---------------------------------------
  ;; Installed FNT strikes are parsed and rasterized entirely in WAT. The
  ;; host boundary is used only to read the virtual file and present dirty
  ;; canonical GDI pixels. Registry record (64 bytes): active/path hash,
  ;; owned FNT WA/size, version, height/ascent/average/max width,
  ;; first/last/default char, weight/charset, face offset, leading values.
  (global $GDI_BITMAP_FONT_TABLE i32 (i32.const 0x07F0A800))
  (global $GDI_BITMAP_FONT_TABLE_SIZE i32 (i32.const 0x00000C00))
  (global $GDI_BITMAP_FONT_COUNT i32 (i32.const 48))
  (global $GDI_BITMAP_FONT_STRIDE i32 (i32.const 64))
  (global $GDI_BITMAP_FONT_IO i32 (i32.const 0x07F0A420))
  (global $GDI_BITMAP_FONT_IO_SIZE i32 (i32.const 0x00000004))
  (global $GDI_BITMAP_FONT_DESC i32 (i32.const 0x07F0A440))
  (global $GDI_BITMAP_FONT_DESC_SIZE i32 (i32.const 0x00000050))
  (global $GDI_BITMAP_FONT_SYSTEM_PATH i32 (i32.const 0x07F0A490))
  (global $GDI_BITMAP_FONT_SYSTEM_STATE i32 (i32.const 0x07F0A4AC))
  (global $GDI_BITMAP_FONT_MS_SANS_PATH i32 (i32.const 0x07F0A4B0))
  (global $GDI_BITMAP_FONT_MS_SANS_STATE i32 (i32.const 0x07F0A4D4))
  (global $GDI_BITMAP_FONT_FIXED_PATH i32 (i32.const 0x07F0A4D8))
  (global $GDI_BITMAP_FONT_FIXED_STATE i32 (i32.const 0x07F0A4F8))
  (global $GDI_BITMAP_FONT_COURIER_PATH i32 (i32.const 0x07F0A4FC))
  (global $GDI_BITMAP_FONT_COURIER_STATE i32 (i32.const 0x07F0A51C))
  (global $GDI_BITMAP_FONT_TERMINAL_PATH i32 (i32.const 0x07F0A5B0))
  (global $GDI_BITMAP_FONT_TERMINAL_STATE i32 (i32.const 0x07F0A5D0))
  (global $GDI_BITMAP_FONT_WESTERN i32 (i32.const 0x07F0A5D4))

  ;; Last-use stamp per strike slot, parallel to the table so the 64-byte
  ;; record layout stays as the .FON parser writes it. The table holds every
  ;; installed .FON strike plus every size of every scalable face the guest has
  ;; asked for, and the second group is unbounded: a font dialog walking its
  ;; size list, or a document at ten sizes in four faces, will exhaust 48 slots.
  ;; Without eviction the allocation simply fails, and the caller falls back to
  ;; MS Sans Serif, so a guest silently starts drawing every subsequent font in
  ;; the wrong face. Evicting the coldest rasterized strike instead costs only
  ;; the work to rebuild it if it is wanted again.
  (global $GDI_BITMAP_FONT_LRU i32 (i32.const 0x07F0A600))
  (global $GDI_BITMAP_FONT_LRU_SIZE i32 (i32.const 0x000000C0))
  (global $gdi_bitmap_font_clock (mut i32) (i32.const 0))

  ;; Browser and CLI hosts preload this tracked file into the process VFS.
  ;; The state word is shared across worker instances: 0=untried, 1=loading,
  ;; 2=installed, 3=unavailable. The resources preserve Wine's embedded and
  ;; ANAKRON's native monochrome strikes; WAT scales them without Canvas text.
  (data (i32.const 0x07F0A490) "C:\\WINDOWS\\FONTS\\SYSTEM.FON\00")
  (data (i32.const 0x07F0A4B0) "C:\\WINDOWS\\FONTS\\MSSANSSERIF.FON\00")
  (data (i32.const 0x07F0A4D8) "C:\\WINDOWS\\FONTS\\FIXEDSYS.FON\00")
  (data (i32.const 0x07F0A4FC) "C:\\WINDOWS\\FONTS\\COURIER.FON\00")
  (data (i32.const 0x07F0A5B0) "C:\\WINDOWS\\FONTS\\TERMINAL.FON\00")
  (data (i32.const 0x07F0A520) "System\00")
  (data (i32.const 0x07F0A528) "Fixedsys\00")
  (data (i32.const 0x07F0A534) "Courier\00")
  (data (i32.const 0x07F0A53C) "MS Sans Serif\00")
  (data (i32.const 0x07F0A54C) "Microsoft Sans Serif\00")
  (data (i32.const 0x07F0A564) "Tahoma\00")
  (data (i32.const 0x07F0A56C) "Helv\00")
  (data (i32.const 0x07F0A574) "sans-serif\00")
  (data (i32.const 0x07F0A580) "MS Shell Dlg\00")
  (data (i32.const 0x07F0A590) "MS Shell Dlg 2\00")
  (data (i32.const 0x07F0A5A0) "Terminal\00")
  (data (i32.const 0x07F0A5D4) "Western\00")

  (func $gdi_bitmap_font_record (param $index i32) (result i32)
    (i32.add (global.get $GDI_BITMAP_FONT_TABLE)
      (i32.mul (local.get $index) (global.get $GDI_BITMAP_FONT_STRIDE))))

  (func $gdi_bitmap_font_stamp (param $record i32) (result i32)
    (i32.add (global.get $GDI_BITMAP_FONT_LRU)
      (i32.mul (i32.div_u
          (i32.sub (local.get $record) (global.get $GDI_BITMAP_FONT_TABLE))
          (global.get $GDI_BITMAP_FONT_STRIDE))
        (i32.const 4))))

  ;; Record that this strike was wanted just now. Called on every lookup that
  ;; hits, not only on creation, so a strike a guest keeps using stays warm.
  (func $gdi_bitmap_font_touch (param $record i32)
    (if (i32.eqz (local.get $record)) (then (return)))
    (global.set $gdi_bitmap_font_clock
      (i32.add (global.get $gdi_bitmap_font_clock) (i32.const 1)))
    (i32.store (call $gdi_bitmap_font_stamp (local.get $record))
      (global.get $gdi_bitmap_font_clock)))

  ;; Free the coldest rasterized strike and return its slot, or 0 if none can
  ;; go. Only state 2 is evictable: an installed .FON strike was put there by
  ;; AddFontResource or by the stock-font bootstrap, it is what the guest asked
  ;; to have installed, and nothing would rebuild it on demand the way
  ;; $tt_strike_ensure rebuilds a substitute.
  (func $gdi_bitmap_font_evict (result i32)
    (local $i i32) (local $record i32) (local $stamp i32)
    (local $best i32) (local $best_stamp i32)
    (local.set $best_stamp (i32.const -1))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_BITMAP_FONT_COUNT)))
      (local.set $record (call $gdi_bitmap_font_record (local.get $i)))
      (if (i32.eq (i32.load (local.get $record)) (i32.const 2))
        (then
          (local.set $stamp (i32.load (call $gdi_bitmap_font_stamp (local.get $record))))
          (if (i32.le_u (local.get $stamp) (local.get $best_stamp))
            (then
              (local.set $best (local.get $record))
              (local.set $best_stamp (local.get $stamp))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.eqz (local.get $best)) (then (return (i32.const 0))))
    ;; Any font object still pointing at this strike has to be told, or it will
    ;; keep rendering from a slot that now belongs to a different face.
    (call $gdi_bitmap_font_unbind_record (local.get $best))
    (call $dib_free_wasm (i32.load offset=8 (local.get $best)))
    (memory.fill (local.get $best) (i32.const 0) (global.get $GDI_BITMAP_FONT_STRIDE))
    (i32.store (call $gdi_bitmap_font_stamp (local.get $best)) (i32.const 0))
    (local.get $best))

  (func $gdi_bitmap_font_path_hash (param $path i32) (result i32)
    (local $hash i32) (local $ch i32)
    (local.set $hash (i32.const 0x811C9DC5))
    (if (i32.eqz (local.get $path)) (then (return (local.get $hash))))
    (block $done (loop $scan
      (local.set $ch (i32.load8_u (local.get $path)))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (i32.eq (local.get $ch) (i32.const 47))
        (then (local.set $ch (i32.const 92))))
      (if (i32.and (i32.ge_u (local.get $ch) (i32.const 65))
            (i32.le_u (local.get $ch) (i32.const 90)))
        (then (local.set $ch (i32.add (local.get $ch) (i32.const 32)))))
      (local.set $hash (i32.mul (i32.xor (local.get $hash) (local.get $ch))
        (i32.const 0x01000193)))
      (local.set $path (i32.add (local.get $path) (i32.const 1)))
      (br $scan)))
    (local.get $hash))

  (func $gdi_bitmap_font_face_equal (param $requested i32) (param $installed i32)
        (result i32)
    (local $a i32) (local $b i32) (local $i i32)
    (if (i32.or (i32.eqz (local.get $requested)) (i32.eqz (local.get $installed)))
      (then (return (i32.const 0))))
    (block $different (loop $scan
      (br_if $different (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $a (i32.load8_u (i32.add (local.get $requested) (local.get $i))))
      (local.set $b (i32.load8_u (i32.add (local.get $installed) (local.get $i))))
      (if (i32.and (i32.ge_u (local.get $a) (i32.const 65)) (i32.le_u (local.get $a) (i32.const 90)))
        (then (local.set $a (i32.add (local.get $a) (i32.const 32)))))
      (if (i32.and (i32.ge_u (local.get $b) (i32.const 65)) (i32.le_u (local.get $b) (i32.const 90)))
        (then (local.set $b (i32.add (local.get $b) (i32.const 32)))))
      (br_if $different (i32.ne (local.get $a) (local.get $b)))
      (if (i32.eqz (local.get $a)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $gdi_bitmap_font_face_matches (param $requested i32) (param $installed i32)
        (result i32)
    (if (call $gdi_bitmap_font_face_equal (local.get $requested) (local.get $installed))
      (then (return (i32.const 1))))
    ;; MS Sans Serif receives the Win9x UI aliases. System, Fixedsys, and the
    ;; ANAKRON-derived Terminal face remain distinct bitmap families.
    (if (i32.eqz (call $gdi_bitmap_font_face_equal
          (local.get $installed) (i32.const 0x07F0A53C)))
      (then (return (i32.const 0))))
    (if (i32.eqz (local.get $requested)) (then (return (i32.const 1))))
    (if (i32.eqz (i32.load8_u (local.get $requested)))
      (then (return (i32.const 1))))
    (if (call $gdi_bitmap_font_face_equal
          (local.get $requested) (i32.const 0x07F0A54C))
      (then (return (i32.const 1))))
    (if (call $gdi_bitmap_font_face_equal
          (local.get $requested) (i32.const 0x07F0A564))
      (then (return (i32.const 1))))
    (if (call $gdi_bitmap_font_face_equal
          (local.get $requested) (i32.const 0x07F0A56C))
      (then (return (i32.const 1))))
    (if (call $gdi_bitmap_font_face_equal
          (local.get $requested) (i32.const 0x07F0A574))
      (then (return (i32.const 1))))
    (if (call $gdi_bitmap_font_face_equal
          (local.get $requested) (i32.const 0x07F0A580))
      (then (return (i32.const 1))))
    (if (call $gdi_bitmap_font_face_equal
          (local.get $requested) (i32.const 0x07F0A590))
      (then (return (i32.const 1))))
    (i32.const 0))

  (func $gdi_bitmap_font_face_equal_wide_a
        (param $requested i32) (param $installed i32) (result i32)
    (local $a i32) (local $b i32) (local $i i32)
    (if (i32.or (i32.eqz (local.get $requested)) (i32.eqz (local.get $installed)))
      (then (return (i32.const 0))))
    (block $different (loop $scan
      (br_if $different (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $a (i32.load16_u (i32.add (local.get $requested)
        (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $b (i32.load8_u (i32.add (local.get $installed) (local.get $i))))
      (if (i32.and (i32.ge_u (local.get $a) (i32.const 65))
            (i32.le_u (local.get $a) (i32.const 90)))
        (then (local.set $a (i32.add (local.get $a) (i32.const 32)))))
      (if (i32.and (i32.ge_u (local.get $b) (i32.const 65))
            (i32.le_u (local.get $b) (i32.const 90)))
        (then (local.set $b (i32.add (local.get $b) (i32.const 32)))))
      (br_if $different (i32.ne (local.get $a) (local.get $b)))
      (if (i32.eqz (local.get $a)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $gdi_bitmap_font_enum_face (param $candidate i32) (result i32)
    (local $record i32)
    (if (i32.eq (local.get $candidate) (i32.const 1))
      (then (return (i32.const 0x0000027E))))
    ;; Past the installed strikes lie the scalable faces: every substitution
    ;; entry with a mounted file, then anything the guest installed itself.
    ;; An application that enumerates before it picks — a font dialog, a word
    ;; processor's face list — must see the names CreateFontIndirect will
    ;; honour, or it offers the user a list our renderer cannot satisfy.
    (if (i32.gt_u (local.get $candidate) (i32.const 17))
      (then (return (call $tt_enum_face_name
        (i32.sub (local.get $candidate) (i32.const 18))))))
    (if (i32.or (i32.lt_u (local.get $candidate) (i32.const 2))
          (i32.gt_u (local.get $candidate) (i32.const 17)))
      (then (return (i32.const 0))))
    (local.set $record (call $gdi_bitmap_font_record
      (i32.sub (local.get $candidate) (i32.const 2))))
    (if (result i32) (i32.eq (i32.load (local.get $record)) (i32.const 1))
      (then (i32.add (i32.load offset=8 (local.get $record))
        (i32.load offset=56 (local.get $record))))
      (else (i32.const 0))))

  (func $gdi_bitmap_font_enum_unique (param $candidate i32) (result i32)
    (local $face i32) (local $i i32) (local $prior i32) (local $prior_face i32)
    (local $limit i32)
    (if (i32.eq (local.get $candidate) (i32.const 1))
      (then (return (i32.const 1))))
    (local.set $face (call $gdi_bitmap_font_enum_face (local.get $candidate)))
    (if (i32.eqz (local.get $face)) (then (return (i32.const 0))))
    (if (call $gdi_bitmap_font_face_equal (local.get $face) (i32.const 0x0000027E))
      (then (return (i32.const 0))))
    ;; A scalable face compares against every installed strike, not just the
    ;; ones before it: drawing text in a substituted face installs a strike
    ;; under that same name, so after any Arial has been drawn the family would
    ;; otherwise be reported twice.
    (local.set $limit
      (if (result i32) (i32.gt_u (local.get $candidate) (i32.const 17))
        (then (i32.const 16))
        (else (i32.sub (local.get $candidate) (i32.const 2)))))
    (block $unique (loop $scan
      (br_if $unique (i32.ge_u (local.get $i) (local.get $limit)))
      (local.set $prior (call $gdi_bitmap_font_record (local.get $i)))
      (if (i32.load (local.get $prior))
        (then
          (local.set $prior_face (i32.add (i32.load offset=8 (local.get $prior))
            (i32.load offset=56 (local.get $prior))))
          (if (call $gdi_bitmap_font_face_equal
                (local.get $face) (local.get $prior_face))
            (then (return (i32.const 0))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 1))

  ;; Candidate 1 is the scalable Arial fallback. Candidates 2..17 address the
  ;; installed FNT table. Returning opaque candidate IDs keeps callback state
  ;; independent from records that may be removed between enumerations.
  (func $gdi_bitmap_font_enum_next (param $after i32) (param $filter i32)
        (param $wide i32) (result i32)
    (local $candidate i32) (local $face i32) (local $matches i32)
    (drop (call $gdi_bitmap_font_ensure_stock))
    (local.set $candidate (i32.add (local.get $after) (i32.const 1)))
    (block $done (loop $scan
      ;; The scalable list ends where it runs out of names rather than at a
      ;; fixed candidate, so ask for the name and stop when there is none.
      (if (i32.gt_u (local.get $candidate) (i32.const 17))
        (then (br_if $done (i32.eqz (call $tt_enum_face_name
          (i32.sub (local.get $candidate) (i32.const 18)))))))
      (local.set $face (call $gdi_bitmap_font_enum_face (local.get $candidate)))
      (if (i32.and (i32.ne (local.get $face) (i32.const 0))
            (call $gdi_bitmap_font_enum_unique (local.get $candidate)))
        (then
          (local.set $matches (i32.or (i32.eqz (local.get $filter))
            (if (result i32) (local.get $wide)
              (then (i32.eqz (i32.load16_u (local.get $filter))))
              (else (i32.eqz (i32.load8_u (local.get $filter)))))))
          (if (i32.eqz (local.get $matches))
            (then
              (local.set $matches
                (if (result i32) (local.get $wide)
                  (then (call $gdi_bitmap_font_face_equal_wide_a
                    (local.get $filter) (local.get $face)))
                  (else (call $gdi_bitmap_font_face_equal
                    (local.get $filter) (local.get $face)))))))
          (if (local.get $matches) (then (return (local.get $candidate))))))
      (local.set $candidate (i32.add (local.get $candidate) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $gdi_bitmap_font_copy_enum_string (param $dst i32) (param $src i32)
        (param $capacity i32) (param $wide i32)
    (local $i i32) (local $ch i32)
    (if (i32.or (i32.eqz (local.get $dst)) (i32.eqz (local.get $capacity)))
      (then (return)))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i)
        (i32.sub (local.get $capacity) (i32.const 1))))
      (local.set $ch (i32.load8_u (i32.add (local.get $src) (local.get $i))))
      (br_if $done (i32.eqz (local.get $ch)))
      (if (local.get $wide)
        (then (i32.store16 (i32.add (local.get $dst)
          (i32.shl (local.get $i) (i32.const 1))) (local.get $ch)))
        (else (i32.store8 (i32.add (local.get $dst) (local.get $i))
          (local.get $ch))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy)))
    (if (local.get $wide)
      (then (i32.store16 (i32.add (local.get $dst)
        (i32.shl (local.get $i) (i32.const 1))) (i32.const 0)))
      (else (i32.store8 (i32.add (local.get $dst) (local.get $i)) (i32.const 0)))))

  ;; TRUETYPE_FONTTYPE (4) for the scalable fallback and every substituted or
  ;; registered face; RASTER_FONTTYPE (1) for an installed strike.
  (func $gdi_bitmap_font_enum_type (param $candidate i32) (result i32)
    (if (result i32) (i32.or (i32.eq (local.get $candidate) (i32.const 1))
          (i32.gt_u (local.get $candidate) (i32.const 17)))
      (then (i32.const 4)) (else (i32.const 1))))

  (func $gdi_bitmap_font_enum_charset (param $candidate i32) (result i32)
    (if (i32.or (i32.eq (local.get $candidate) (i32.const 1))
          (i32.gt_u (local.get $candidate) (i32.const 17)))
      (then (return (i32.const 0))))  ;; ANSI_CHARSET
    (if (i32.or (i32.lt_u (local.get $candidate) (i32.const 2))
          (i32.gt_u (local.get $candidate) (i32.const 17)))
      (then (return (i32.const -1))))
    (i32.load offset=52 (call $gdi_bitmap_font_record
      (i32.sub (local.get $candidate) (i32.const 2)))))

  ;; Fill ENUMLOGFONTEXA/W and NEWTEXTMETRICEXA/W from the selected provider.
  ;; The scalable fallback keeps deterministic compatibility metrics; installed
  ;; FNT faces expose their parsed native strike metrics without Canvas.
  (func $gdi_bitmap_font_enum_fill (param $candidate i32) (param $lf i32)
        (param $tm i32) (param $wide i32) (result i32)
    (local $record i32) (local $source i32) (local $face i32)
    (local $height i32) (local $ascent i32) (local $average i32)
    (local $maximum i32) (local $weight i32) (local $charset i32)
    (local $pitch i32) (local $first i32) (local $last i32)
    (local $default i32) (local $break i32) (local $internal i32) (local $external i32)
    (local $italic i32) (local $underlined i32) (local $struck i32)
    (local $metrics i32)
    (if (i32.or (i32.eqz (local.get $lf)) (i32.eqz (local.get $tm)))
      (then (return (i32.const 0))))
    (local.set $face (call $gdi_bitmap_font_enum_face (local.get $candidate)))
    (if (i32.eqz (local.get $face)) (then (return (i32.const 0))))
    (if (i32.or (i32.eq (local.get $candidate) (i32.const 1))
          (i32.gt_u (local.get $candidate) (i32.const 17)))
      (then
        (local.set $height (i32.const 16))
        (local.set $ascent (i32.const 13))
        (local.set $average (i32.const 8))
        (local.set $maximum (i32.const 16))
        (local.set $weight (i32.const 400))
        (local.set $pitch (i32.const 0x22))
        (local.set $first (i32.const 32))
        (local.set $last (i32.const 255))
        (local.set $default (i32.const 31))
        (local.set $break (i32.const 32))
        ;; Report the face's own metrics at the same nominal 16-pixel em the
        ;; fallback uses. Enumeration answers "what is available", so a
        ;; nominal size is the honest answer; the numbers still come from the
        ;; file rather than from a table of guesses. Zero means the file could
        ;; not be opened, and the fallback metrics above stand.
        (if (i32.gt_u (local.get $candidate) (i32.const 17))
          (then
            (local.set $metrics
              (call $tt_enum_face_metrics (local.get $face) (i32.const 16)))
            (if (local.get $metrics)
              (then
                (local.set $height
                  (i32.and (local.get $metrics) (i32.const 0xFF)))
                (local.set $ascent (i32.and
                  (i32.shr_u (local.get $metrics) (i32.const 8))
                  (i32.const 0xFF)))
                (local.set $average (i32.and
                  (i32.shr_u (local.get $metrics) (i32.const 16))
                  (i32.const 0xFF)))
                (local.set $maximum (i32.and
                  (i32.shr_u (local.get $metrics) (i32.const 24))
                  (i32.const 0xFF))))))))
      (else
        (local.set $record (call $gdi_bitmap_font_record
          (i32.sub (local.get $candidate) (i32.const 2))))
        (local.set $source (i32.load offset=8 (local.get $record)))
        (local.set $height (i32.load offset=20 (local.get $record)))
        (local.set $ascent (i32.load offset=24 (local.get $record)))
        (local.set $average (i32.load offset=28 (local.get $record)))
        (local.set $maximum (i32.load offset=32 (local.get $record)))
        (local.set $weight (i32.load offset=48 (local.get $record)))
        (local.set $charset (i32.load offset=52 (local.get $record)))
        (local.set $pitch (i32.load8_u offset=90 (local.get $source)))
        (local.set $first (i32.load offset=36 (local.get $record)))
        (local.set $last (i32.load offset=40 (local.get $record)))
        (local.set $default (i32.load offset=44 (local.get $record)))
        (local.set $break (i32.add (local.get $first)
          (i32.load8_u offset=98 (local.get $source))))
        (local.set $internal (i32.and (i32.load offset=60 (local.get $record))
          (i32.const 0xFFFF)))
        (local.set $external (i32.shr_u
          (i32.load offset=60 (local.get $record)) (i32.const 16)))
        (local.set $italic (i32.load8_u offset=80 (local.get $source)))
        (local.set $underlined (i32.load8_u offset=81 (local.get $source)))
        (local.set $struck (i32.load8_u offset=82 (local.get $source)))))
    (if (i32.eqz (local.get $weight)) (then (local.set $weight (i32.const 400))))
    (memory.fill (local.get $lf) (i32.const 0)
      (select (i32.const 384) (i32.const 192) (local.get $wide)))
    (memory.fill (local.get $tm) (i32.const 0) (i32.const 128))
    (i32.store (local.get $lf) (i32.sub (i32.const 0) (local.get $height)))
    (i32.store offset=16 (local.get $lf) (local.get $weight))
    (i32.store8 offset=20 (local.get $lf) (local.get $italic))
    (i32.store8 offset=21 (local.get $lf) (local.get $underlined))
    (i32.store8 offset=22 (local.get $lf) (local.get $struck))
    (i32.store8 offset=23 (local.get $lf) (local.get $charset))
    (i32.store8 offset=27 (local.get $lf) (local.get $pitch))
    (call $gdi_bitmap_font_copy_enum_string
      (i32.add (local.get $lf) (i32.const 28)) (local.get $face)
      (i32.const 32) (local.get $wide))
    (call $gdi_bitmap_font_copy_enum_string
      (i32.add (local.get $lf) (select (i32.const 92) (i32.const 60) (local.get $wide)))
      (local.get $face) (i32.const 64) (local.get $wide))
    (call $gdi_bitmap_font_copy_enum_string
      (i32.add (local.get $lf) (select (i32.const 220) (i32.const 124) (local.get $wide)))
      (i32.const 0x000002A0) (i32.const 32) (local.get $wide))
    (call $gdi_bitmap_font_copy_enum_string
      (i32.add (local.get $lf) (select (i32.const 284) (i32.const 156) (local.get $wide)))
      (global.get $GDI_BITMAP_FONT_WESTERN) (i32.const 32) (local.get $wide))
    (i32.store (local.get $tm) (local.get $height))
    (i32.store offset=4 (local.get $tm) (local.get $ascent))
    (i32.store offset=8 (local.get $tm)
      (select (i32.sub (local.get $height) (local.get $ascent)) (i32.const 0)
        (i32.gt_u (local.get $height) (local.get $ascent))))
    (i32.store offset=12 (local.get $tm) (local.get $internal))
    (i32.store offset=16 (local.get $tm) (local.get $external))
    (i32.store offset=20 (local.get $tm) (local.get $average))
    (i32.store offset=24 (local.get $tm) (local.get $maximum))
    (i32.store offset=28 (local.get $tm) (local.get $weight))
    (i32.store offset=36 (local.get $tm) (i32.const 96))
    (i32.store offset=40 (local.get $tm) (i32.const 96))
    (if (local.get $wide)
      (then
        (i32.store16 offset=44 (local.get $tm) (local.get $first))
        (i32.store16 offset=46 (local.get $tm) (local.get $last))
        (i32.store16 offset=48 (local.get $tm) (local.get $default))
        (i32.store16 offset=50 (local.get $tm) (local.get $break))
        (i32.store8 offset=52 (local.get $tm) (local.get $italic))
        (i32.store8 offset=53 (local.get $tm) (local.get $underlined))
        (i32.store8 offset=54 (local.get $tm) (local.get $struck))
        (i32.store8 offset=55 (local.get $tm) (local.get $pitch))
        (i32.store8 offset=56 (local.get $tm) (local.get $charset))
        (i32.store offset=64 (local.get $tm) (local.get $height))
        (i32.store offset=68 (local.get $tm) (local.get $height))
        (i32.store offset=72 (local.get $tm) (local.get $average)))
      (else
        (i32.store8 offset=44 (local.get $tm) (local.get $first))
        (i32.store8 offset=45 (local.get $tm) (local.get $last))
        (i32.store8 offset=46 (local.get $tm) (local.get $default))
        (i32.store8 offset=47 (local.get $tm) (local.get $break))
        (i32.store8 offset=48 (local.get $tm) (local.get $italic))
        (i32.store8 offset=49 (local.get $tm) (local.get $underlined))
        (i32.store8 offset=50 (local.get $tm) (local.get $struck))
        (i32.store8 offset=51 (local.get $tm) (local.get $pitch))
        (i32.store8 offset=52 (local.get $tm) (local.get $charset))
        (i32.store offset=60 (local.get $tm) (local.get $height))
        (i32.store offset=64 (local.get $tm) (local.get $height))
        (i32.store offset=68 (local.get $tm) (local.get $average))))
    (i32.const 1))

  ;; Font enumeration is a resumable guest callback sequence. Its 560-byte
  ;; context and output structures live below the already-cleaned API frame:
  ;; magic, callback, lParam, return EIP/ESP, candidate, filter, wide, charset,
  ;; then ENUMLOGFONTEX and NEWTEXTMETRICEX buffers. CACA0011 resumes through
  ;; $gdi_font_enum_continue after each stdcall FONTENUMPROC return.
  (func $gdi_font_enum_finish (param $ctx i32) (param $result i32)
    (global.set $eip (call $gl32 (i32.add (local.get $ctx) (i32.const 12))))
    (global.set $esp (call $gl32 (i32.add (local.get $ctx) (i32.const 16))))
    (global.set $eax (local.get $result)))

  (func $gdi_font_enum_advance (param $ctx i32)
    (local $candidate i32) (local $filter_g i32) (local $filter i32)
    (local $wide i32) (local $charset i32) (local $lf_g i32) (local $tm_g i32)
    (local.set $filter_g (call $gl32 (i32.add (local.get $ctx) (i32.const 24))))
    (if (local.get $filter_g) (then (local.set $filter (call $g2w (local.get $filter_g)))))
    (local.set $wide (call $gl32 (i32.add (local.get $ctx) (i32.const 28))))
    (local.set $charset (call $gl32 (i32.add (local.get $ctx) (i32.const 32))))
    (local.set $candidate (call $gl32 (i32.add (local.get $ctx) (i32.const 20))))
    (block $found (loop $scan
      (local.set $candidate (call $gdi_bitmap_font_enum_next
        (local.get $candidate) (local.get $filter) (local.get $wide)))
      (br_if $found (i32.eqz (local.get $candidate)))
      (br_if $found (i32.or (i32.eq (local.get $charset) (i32.const 0xFF))
        (i32.eq (local.get $charset)
          (call $gdi_bitmap_font_enum_charset (local.get $candidate)))))
      (br $scan)))
    (if (i32.eqz (local.get $candidate))
      (then
        (call $gdi_font_enum_finish (local.get $ctx)
          (select (global.get $eax) (i32.const 1)
            (i32.ne (call $gl32 (i32.add (local.get $ctx) (i32.const 20)))
              (i32.const 0))))
        (return)))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 20)) (local.get $candidate))
    (local.set $lf_g (i32.add (local.get $ctx) (i32.const 48)))
    (local.set $tm_g (i32.add (local.get $ctx) (i32.const 432)))
    (if (i32.eqz (call $gdi_bitmap_font_enum_fill (local.get $candidate)
          (call $g2w (local.get $lf_g)) (call $g2w (local.get $tm_g))
          (local.get $wide)))
      (then (call $gdi_font_enum_finish (local.get $ctx) (i32.const 0)) (return)))
    (global.set $esp (local.get $ctx))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gl32 (i32.add (local.get $ctx) (i32.const 8))))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (call $gdi_bitmap_font_enum_type (local.get $candidate)))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $tm_g))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $lf_g))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $font_enum_ret_thunk))
    (global.set $eip (call $gl32 (i32.add (local.get $ctx) (i32.const 4))))
    (global.set $steps (i32.const 0)))

  (func $gdi_font_enum_continue
    (local $ctx i32)
    (local.set $ctx (global.get $esp))
    (if (i32.ne (call $gl32 (local.get $ctx)) (i32.const 0x434E5446))
      (then (return)))
    (if (i32.eqz (global.get $eax))
      (then (call $gdi_font_enum_finish (local.get $ctx) (i32.const 0)) (return)))
    (call $gdi_font_enum_advance (local.get $ctx)))

  (func $gdi_font_enum_start (param $callback i32) (param $lparam i32)
        (param $ret i32) (param $return_esp i32) (param $filter i32)
        (param $wide i32) (param $charset i32)
    (local $ctx i32)
    (if (i32.eqz (local.get $callback))
      (then
        (global.set $eax (i32.const 0))
        (global.set $eip (local.get $ret))
        (global.set $esp (local.get $return_esp))
        (return)))
    (global.set $esp (i32.sub (local.get $return_esp) (i32.const 560)))
    (local.set $ctx (global.get $esp))
    (call $zero_memory (call $g2w (local.get $ctx)) (i32.const 560))
    (call $gs32 (local.get $ctx) (i32.const 0x434E5446)) ;; "FNTC"
    (call $gs32 (i32.add (local.get $ctx) (i32.const 4)) (local.get $callback))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 8)) (local.get $lparam))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 12)) (local.get $ret))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 16)) (local.get $return_esp))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 24)) (local.get $filter))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 28)) (local.get $wide))
    (call $gs32 (i32.add (local.get $ctx) (i32.const 32)) (local.get $charset))
    (call $gdi_font_enum_advance (local.get $ctx)))

  (func $gdi_bitmap_font_unbind_record (param $strike i32)
    (local $i i32) (local $object i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_OBJECT_COUNT)))
      (local.set $object (i32.add (global.get $GDI_OBJECT_TABLE)
        (i32.mul (local.get $i) (global.get $GDI_OBJECT_STRIDE))))
      (if (i32.and (i32.eq (i32.load offset=4 (local.get $object)) (i32.const 4))
            (i32.eq (i32.load offset=24 (local.get $object)) (local.get $strike)))
        (then
          (i32.store offset=20 (local.get $object)
            (i32.and (i32.load offset=20 (local.get $object)) (i32.const -2)))
          (i32.store offset=24 (local.get $object) (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  (func $gdi_bitmap_font_remove_hash (param $hash i32) (result i32)
    (local $i i32) (local $record i32) (local $removed i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_BITMAP_FONT_COUNT)))
      (local.set $record (call $gdi_bitmap_font_record (local.get $i)))
      (if (i32.and (i32.load (local.get $record))
            (i32.eq (i32.load offset=4 (local.get $record)) (local.get $hash)))
        (then
          (call $gdi_bitmap_font_unbind_record (local.get $record))
          (call $dib_free_wasm (i32.load offset=8 (local.get $record)))
          (memory.fill (local.get $record) (i32.const 0) (global.get $GDI_BITMAP_FONT_STRIDE))
          (local.set $removed (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $removed))

  (func $gdi_bitmap_font_copy_strike (param $source i32) (param $available i32)
        (param $hash i32) (result i32)
    (local $version i32) (local $size i32) (local $height i32)
    (local $first i32) (local $last i32) (local $count i32)
    (local $table i32) (local $entry_size i32) (local $face i32)
    (local $i i32) (local $entry i32) (local $width i32) (local $offset i32)
    (local $bytes i32) (local $record i32) (local $copy_guest i32) (local $copy i32)
    (if (i32.lt_u (local.get $available) (i32.const 118))
      (then (return (i32.const 0))))
    (local.set $version (i32.load16_u (local.get $source)))
    (if (i32.and (i32.ne (local.get $version) (i32.const 0x0200))
          (i32.ne (local.get $version) (i32.const 0x0300)))
      (then (return (i32.const 0))))
    (local.set $size (i32.load offset=2 (local.get $source)))
    (if (i32.eqz (local.get $size)) (then (local.set $size (local.get $available))))
    (if (i32.or (i32.lt_u (local.get $size) (i32.const 118))
          (i32.gt_u (local.get $size) (local.get $available)))
      (then (return (i32.const 0))))
    (local.set $height (i32.load16_u offset=88 (local.get $source)))
    (local.set $first (i32.load8_u offset=95 (local.get $source)))
    (local.set $last (i32.load8_u offset=96 (local.get $source)))
    (local.set $face (i32.load offset=105 (local.get $source)))
    (if (i32.or (i32.eqz (local.get $height))
          (i32.or (i32.gt_u (local.get $height) (i32.const 256))
            (i32.or (i32.lt_u (local.get $last) (local.get $first))
              (i32.or (i32.eqz (local.get $face)) (i32.ge_u (local.get $face) (local.get $size))))))
      (then (return (i32.const 0))))
    (local.set $table (select (i32.const 118) (i32.const 148)
      (i32.eq (local.get $version) (i32.const 0x0200))))
    (local.set $entry_size (select (i32.const 4) (i32.const 6)
      (i32.eq (local.get $version) (i32.const 0x0200))))
    (local.set $count (i32.add (i32.sub (local.get $last) (local.get $first)) (i32.const 1)))
    (if (i32.gt_u (i32.add (local.get $table)
          (i32.mul (i32.add (local.get $count) (i32.const 1)) (local.get $entry_size)))
        (local.get $size))
      (then (return (i32.const 0))))
    ;; Require a terminated face and fully contained vertical-strip glyph data.
    (local.set $i (local.get $face))
    (block $face_ok (loop $face_scan
      (if (i32.ge_u (local.get $i) (local.get $size)) (then (return (i32.const 0))))
      (br_if $face_ok (i32.eqz (i32.load8_u (i32.add (local.get $source) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $face_scan)))
    (local.set $i (i32.const 0))
    (block $glyphs_ok (loop $glyphs
      (br_if $glyphs_ok (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $entry (i32.add (local.get $source)
        (i32.add (local.get $table) (i32.mul (local.get $i) (local.get $entry_size)))))
      (local.set $width (i32.load16_u (local.get $entry)))
      (local.set $offset (select (i32.load16_u offset=2 (local.get $entry))
        (i32.load offset=2 (local.get $entry))
        (i32.eq (local.get $version) (i32.const 0x0200))))
      (local.set $bytes (i32.mul
        (i32.shr_u (i32.add (local.get $width) (i32.const 7)) (i32.const 3))
        (local.get $height)))
      (if (i32.or (i32.eqz (local.get $width))
            (i32.or (i32.ge_u (local.get $offset) (local.get $size))
              (i32.gt_u (local.get $bytes) (i32.sub (local.get $size) (local.get $offset)))))
        (then (return (i32.const 0))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $glyphs)))
    (local.set $i (i32.const 0))
    (block $slot_done (loop $slots
      (br_if $slot_done (i32.ge_u (local.get $i) (global.get $GDI_BITMAP_FONT_COUNT)))
      (local.set $record (call $gdi_bitmap_font_record (local.get $i)))
      (br_if $slot_done (i32.eqz (i32.load (local.get $record))))
      (local.set $record (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $slots)))
    (if (i32.eqz (local.get $record))
      (then (local.set $record (call $gdi_bitmap_font_evict))))
    (if (i32.eqz (local.get $record)) (then (return (i32.const 0))))
    (local.set $copy_guest (call $dib_alloc (local.get $size)))
    (if (i32.eqz (local.get $copy_guest)) (then (return (i32.const 0))))
    (local.set $copy (call $g2w (local.get $copy_guest)))
    (memory.copy (local.get $copy) (local.get $source) (local.get $size))
    (i32.store (local.get $record) (i32.const 1))
    (i32.store offset=4 (local.get $record) (local.get $hash))
    (i32.store offset=8 (local.get $record) (local.get $copy))
    (i32.store offset=12 (local.get $record) (local.get $size))
    (i32.store offset=16 (local.get $record) (local.get $version))
    (i32.store offset=20 (local.get $record) (local.get $height))
    (i32.store offset=24 (local.get $record) (i32.load16_u offset=74 (local.get $source)))
    (i32.store offset=28 (local.get $record) (i32.load16_u offset=91 (local.get $source)))
    (i32.store offset=32 (local.get $record) (i32.load16_u offset=93 (local.get $source)))
    (i32.store offset=36 (local.get $record) (local.get $first))
    (i32.store offset=40 (local.get $record) (local.get $last))
    (i32.store offset=44 (local.get $record)
      (i32.add (local.get $first) (i32.load8_u offset=97 (local.get $source))))
    (i32.store offset=48 (local.get $record) (i32.load16_u offset=83 (local.get $source)))
    (i32.store offset=52 (local.get $record) (i32.load8_u offset=85 (local.get $source)))
    (i32.store offset=56 (local.get $record) (local.get $face))
    (i32.store offset=60 (local.get $record) (i32.or
      (i32.load16_u offset=76 (local.get $source))
      (i32.shl (i32.load16_u offset=78 (local.get $source)) (i32.const 16))))
    (call $gdi_bitmap_font_touch (local.get $record))
    (i32.const 1))

  (func $gdi_bitmap_font_parse_file (param $data i32) (param $size i32)
        (param $hash i32) (result i32)
    (local $ne i32) (local $p i32) (local $shift i32) (local $type i32)
    (local $count i32) (local $i i32) (local $offset i32) (local $length i32)
    (local $loaded i32)
    (if (i32.lt_u (local.get $size) (i32.const 2)) (then (return (i32.const 0))))
    (if (i32.or (i32.eq (i32.load16_u (local.get $data)) (i32.const 0x0200))
          (i32.eq (i32.load16_u (local.get $data)) (i32.const 0x0300)))
      (then (return (call $gdi_bitmap_font_copy_strike
        (local.get $data) (local.get $size) (local.get $hash)))))
    (if (i32.or (i32.lt_u (local.get $size) (i32.const 64))
          (i32.ne (i32.load16_u (local.get $data)) (i32.const 0x5A4D)))
      (then (return (i32.const 0))))
    (local.set $ne (i32.load offset=60 (local.get $data)))
    (if (i32.or (i32.gt_u (local.get $ne) (i32.sub (local.get $size) (i32.const 40)))
          (i32.ne (i32.load16_u (i32.add (local.get $data) (local.get $ne))) (i32.const 0x454E)))
      (then (return (i32.const 0))))
    (local.set $p (i32.add (local.get $ne)
      (i32.load16_u (i32.add (local.get $data) (i32.add (local.get $ne) (i32.const 36))))))
    (if (i32.gt_u (local.get $p) (i32.sub (local.get $size) (i32.const 2)))
      (then (return (i32.const 0))))
    (local.set $shift (i32.load16_u (i32.add (local.get $data) (local.get $p))))
    (if (i32.gt_u (local.get $shift) (i32.const 24)) (then (return (i32.const 0))))
    (local.set $p (i32.add (local.get $p) (i32.const 2)))
    (block $types_done (loop $types
      (br_if $types_done (i32.gt_u (local.get $p) (i32.sub (local.get $size) (i32.const 8))))
      (local.set $type (i32.load16_u (i32.add (local.get $data) (local.get $p))))
      (br_if $types_done (i32.eqz (local.get $type)))
      (local.set $count (i32.load16_u
        (i32.add (local.get $data) (i32.add (local.get $p) (i32.const 2)))))
      (local.set $p (i32.add (local.get $p) (i32.const 8)))
      (local.set $i (i32.const 0))
      (block $resources_done (loop $resources
        (br_if $resources_done (i32.ge_u (local.get $i) (local.get $count)))
        (if (i32.gt_u (local.get $p) (i32.sub (local.get $size) (i32.const 12)))
          (then (return (local.get $loaded))))
        (if (i32.eq (i32.and (local.get $type) (i32.const 0x7FFF)) (i32.const 8))
          (then
            (local.set $offset (i32.shl (i32.load16_u
              (i32.add (local.get $data) (local.get $p))) (local.get $shift)))
            (local.set $length (i32.shl (i32.load16_u
              (i32.add (local.get $data) (i32.add (local.get $p) (i32.const 2)))) (local.get $shift)))
            (if (i32.and (i32.lt_u (local.get $offset) (local.get $size))
                  (i32.and (i32.gt_u (local.get $length) (i32.const 0))
                    (i32.le_u (local.get $length) (i32.sub (local.get $size) (local.get $offset)))))
              (then (local.set $loaded (i32.add (local.get $loaded)
                (call $gdi_bitmap_font_copy_strike
                  (i32.add (local.get $data) (local.get $offset))
                  (local.get $length) (local.get $hash))))))))
        (local.set $p (i32.add (local.get $p) (i32.const 12)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $resources)))
      (br $types)))
    (local.get $loaded))

  (func $gdi_bitmap_font_add_resource (param $path_guest i32) (result i32)
    (local $path i32) (local $hash i32) (local $handle i32) (local $size i32)
    (local $data_guest i32) (local $data i32) (local $loaded i32)
    (if (i32.eqz (local.get $path_guest)) (then (return (i32.const 0))))
    (local.set $path (call $g2w (local.get $path_guest)))
    (local.set $hash (call $gdi_bitmap_font_path_hash (local.get $path)))
    (local.set $handle (call $host_fs_create_file (local.get $path)
      (i32.const 0x80000000) (i32.const 3) (i32.const 0x80) (i32.const 0)))
    (if (i32.eq (local.get $handle) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $size (call $host_fs_get_file_size (local.get $handle)))
    (if (i32.or (i32.le_s (local.get $size) (i32.const 0))
          (i32.gt_u (local.get $size) (i32.const 0x000F0000)))
      (then (drop (call $host_fs_close_handle (local.get $handle))) (return (i32.const 0))))
    ;; The filesystem bridge accepts guest pointers in the direct window.
    ;; Parse from a temporary heap buffer, then copy validated strikes into
    ;; the WAT-only DIB arena where the host never needs to address them.
    (local.set $data_guest (call $heap_alloc (local.get $size)))
    (if (i32.eqz (local.get $data_guest))
      (then (drop (call $host_fs_close_handle (local.get $handle))) (return (i32.const 0))))
    (local.set $data (call $g2w (local.get $data_guest)))
    (i32.store (global.get $GDI_BITMAP_FONT_IO) (i32.const 0))
    (if (i32.eqz (call $host_fs_read_file (local.get $handle) (local.get $data_guest)
          (local.get $size) (call $w2g (global.get $GDI_BITMAP_FONT_IO))))
      (then
        (drop (call $host_fs_close_handle (local.get $handle)))
        (call $heap_free (local.get $data_guest))
        (return (i32.const 0))))
    (drop (call $host_fs_close_handle (local.get $handle)))
    (if (i32.ne (i32.load (global.get $GDI_BITMAP_FONT_IO)) (local.get $size))
      (then (call $heap_free (local.get $data_guest)) (return (i32.const 0))))
    (drop (call $gdi_bitmap_font_remove_hash (local.get $hash)))
    (local.set $loaded (call $gdi_bitmap_font_parse_file
      (local.get $data) (local.get $size) (local.get $hash)))
    (call $heap_free (local.get $data_guest))
    (local.get $loaded))

  (func $gdi_bitmap_font_remove_resource (param $path_guest i32) (result i32)
    (if (i32.eqz (local.get $path_guest)) (then (return (i32.const 0))))
    (call $gdi_bitmap_font_remove_hash
      (call $gdi_bitmap_font_path_hash (call $g2w (local.get $path_guest)))))

  (func $gdi_bitmap_font_ensure (param $path i32) (param $state_ptr i32)
        (result i32)
    (local $state i32) (local $loaded i32)
    (local.set $state (i32.load (local.get $state_ptr)))
    (if (i32.eq (local.get $state) (i32.const 2))
      (then (return (i32.const 1))))
    ;; Another shared-memory worker is already loading it. That first call may
    ;; use Canvas, but all later calls observe state 2 and use the FON.
    (if (i32.eq (local.get $state) (i32.const 1))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $state) (i32.const 3))
      (then (return (i32.const 0))))
    (i32.store (local.get $state_ptr) (i32.const 1))
    (local.set $loaded (call $gdi_bitmap_font_add_resource
      (call $w2g (local.get $path))))
    (i32.store (local.get $state_ptr)
      (select (i32.const 2) (i32.const 3) (i32.gt_s (local.get $loaded) (i32.const 0))))
    (i32.gt_s (local.get $loaded) (i32.const 0)))

  (func $gdi_bitmap_font_ensure_system (result i32)
    (call $gdi_bitmap_font_ensure
      (global.get $GDI_BITMAP_FONT_SYSTEM_PATH)
      (global.get $GDI_BITMAP_FONT_SYSTEM_STATE)))

  (func $gdi_bitmap_font_ensure_ms_sans (result i32)
    (call $gdi_bitmap_font_ensure
      (global.get $GDI_BITMAP_FONT_MS_SANS_PATH)
      (global.get $GDI_BITMAP_FONT_MS_SANS_STATE)))

  (func $gdi_bitmap_font_ensure_fixed (result i32)
    (call $gdi_bitmap_font_ensure
      (global.get $GDI_BITMAP_FONT_FIXED_PATH)
      (global.get $GDI_BITMAP_FONT_FIXED_STATE)))

  (func $gdi_bitmap_font_ensure_courier (result i32)
    (call $gdi_bitmap_font_ensure
      (global.get $GDI_BITMAP_FONT_COURIER_PATH)
      (global.get $GDI_BITMAP_FONT_COURIER_STATE)))

  (func $gdi_bitmap_font_ensure_terminal (result i32)
    (call $gdi_bitmap_font_ensure
      (global.get $GDI_BITMAP_FONT_TERMINAL_PATH)
      (global.get $GDI_BITMAP_FONT_TERMINAL_STATE)))

  (func $gdi_bitmap_font_ensure_stock (result i32)
    (local $loaded i32)
    (local.set $loaded (call $gdi_bitmap_font_ensure_system))
    (local.set $loaded (i32.or (local.get $loaded)
      (call $gdi_bitmap_font_ensure_ms_sans)))
    (local.set $loaded (i32.or (local.get $loaded)
      (call $gdi_bitmap_font_ensure_fixed)))
    (local.set $loaded (i32.or (local.get $loaded)
      (call $gdi_bitmap_font_ensure_courier)))
    (local.set $loaded (i32.or (local.get $loaded)
      (call $gdi_bitmap_font_ensure_terminal)))
    (local.get $loaded))

  (func $gdi_bitmap_font_best (param $face i32) (param $request i32) (result i32)
    (local $i i32) (local $strike i32) (local $best i32)
    (local $distance i32) (local $best_distance i32)
    (if (i32.lt_s (local.get $request) (i32.const 0))
      (then (local.set $request (i32.sub (i32.const 0) (local.get $request)))))
    (local.set $best_distance (i32.const 0x7FFFFFFF))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_BITMAP_FONT_COUNT)))
      (local.set $strike (call $gdi_bitmap_font_record (local.get $i)))
      ;; Only installed strikes (state 1) are matched by face and height.
      ;; Strikes rasterized from a scalable substitute (state 2) are reachable
      ;; only through their exact (face, size, weight, italic) key: matching
      ;; one by name and nearest height would bind, say, a 17px Arial built for
      ;; one control to every other size the guest later asks for.
      (if (i32.and (i32.eq (i32.load (local.get $strike)) (i32.const 1))
            (call $gdi_bitmap_font_face_matches (local.get $face)
              (i32.add (i32.load offset=8 (local.get $strike))
                (i32.load offset=56 (local.get $strike)))))
        (then
          (local.set $distance (i32.sub (select (local.get $request)
            (i32.load offset=20 (local.get $strike)) (local.get $request))
            (i32.load offset=20 (local.get $strike))))
          (if (i32.lt_s (local.get $distance) (i32.const 0))
            (then (local.set $distance (i32.sub (i32.const 0) (local.get $distance)))))
          (if (i32.lt_s (local.get $distance) (local.get $best_distance))
            (then
              (local.set $best (local.get $strike))
              (local.set $best_distance (local.get $distance))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $best))

  (func $gdi_bitmap_font_bind (param $handle i32) (param $face i32)
    (local $object i32) (local $best i32)
    (drop (call $gdi_bitmap_font_ensure_stock))
    (local.set $object (call $gdi_object_record (local.get $handle)))
    (if (i32.eqz (local.get $object)) (then (return)))
    (local.set $best (call $gdi_bitmap_font_best
      (local.get $face) (i32.load offset=8 (local.get $object))))
    (if (local.get $best)
      (then
        (i32.store offset=20 (local.get $object)
          (i32.or (i32.load offset=20 (local.get $object)) (i32.const 1)))
        (i32.store offset=24 (local.get $object) (local.get $best)))))

  (func $gdi_bitmap_font_selected (param $hdc i32) (result i32)
    (local $dc i32) (local $handle i32) (local $object i32) (local $strike i32)
    (local $substitute i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (if (i32.eqz (local.get $dc)) (then (return (i32.const 0))))
    (local.set $handle (i32.load offset=88 (local.get $dc)))
    (local.set $object (call $gdi_object_record (local.get $handle)))
    (if (i32.and (i32.ne (local.get $object) (i32.const 0))
          (i32.eq (i32.load offset=4 (local.get $object)) (i32.const 4)))
      (then
        (local.set $strike (i32.load offset=24 (local.get $object)))
        (if (i32.and (i32.ne (local.get $strike) (i32.const 0))
              (i32.ne (i32.load (local.get $strike)) (i32.const 0)))
          (then
            ;; The bound strike was chosen at CreateFont time by face name and
            ;; height alone, so a bold or italic request can land on the
            ;; upright regular strike of the same face. When the style does not
            ;; match, a scalable substitute rasterized at the exact requested
            ;; style is closer to what was asked for than a mismatched bitmap;
            ;; when it does match, the bitmap wins, because an installed strike
            ;; is pixel-exact and an outline rasterized at UI sizes is not.
            (if (i32.or
                  (i32.ne
                    (i32.ge_s (i32.load offset=48 (local.get $strike))
                      (i32.const 700))
                    (i32.ge_s (call $gdi_font_weight (local.get $handle))
                      (i32.const 700)))
                  (i32.ne (call $gdi_font_italic (local.get $handle))
                    (i32.const 0)))
              (then
                (local.set $substitute (call $tt_strike_ensure
                  (call $gdi_font_face (local.get $handle))
                  (call $gdi_font_height (local.get $handle))
                  (call $gdi_font_weight (local.get $handle))
                  (call $gdi_font_italic (local.get $handle))))
                (if (local.get $substitute)
                  (then (return (local.get $substitute))))))
            (return (local.get $strike))))))
    (if (i32.eq (local.get $handle) (i32.const 0x3001A))
      (then
        (drop (call $gdi_bitmap_font_ensure_terminal))
        (return (call $gdi_bitmap_font_best
          (i32.const 0x07F0A5A0) (i32.const 12)))))
    (if (i32.eq (local.get $handle) (i32.const 0x30020))
      (then
        (drop (call $gdi_bitmap_font_ensure_fixed))
        (return (call $gdi_bitmap_font_best
          (i32.const 0x07F0A528) (call $gdi_font_height (local.get $handle))))))
    (if (i32.eq (local.get $handle) (i32.const 0x3001B))
      (then
        (drop (call $gdi_bitmap_font_ensure_courier))
        (return (call $gdi_bitmap_font_best
          (i32.const 0x07F0A534) (i32.const 13)))))
    (if (i32.eq (local.get $handle) (i32.const 0x3001D))
      (then
        (drop (call $gdi_bitmap_font_ensure_system))
        (return (call $gdi_bitmap_font_best
          (i32.const 0x07F0A520) (i32.const 16)))))
    ;; Remaining variable stock UI fonts use Wine MS Sans Serif.
    (if (i32.or (i32.eq (local.get $handle) (i32.const 0x3001C))
          (i32.or (i32.eq (local.get $handle) (i32.const 0x3001E))
            (i32.or (i32.eq (local.get $handle) (i32.const 0x30021))
              (i32.eq (local.get $handle) (i32.const 0x30022)))))
      (then
        (drop (call $gdi_bitmap_font_ensure_ms_sans))
        (return (call $gdi_bitmap_font_best
          (i32.const 0x07F0A53C) (call $gdi_font_height (local.get $handle))))))
    ;; No installed strike carries this face, so rasterize the substitute for
    ;; it into a strike and render it through this same path. $tt_subst_path
    ;; answers for any face that was named, so the only way through here
    ;; without a strike is a LOGFONT that named no face at all, or a font file
    ;; that failed to load.
    (local.set $substitute (call $tt_strike_ensure
      (call $gdi_font_face (local.get $handle))
      (call $gdi_font_height (local.get $handle))
      (call $gdi_font_weight (local.get $handle))
      (call $gdi_font_italic (local.get $handle))))
    (if (local.get $substitute) (then (return (local.get $substitute))))
    ;; An unnamed face is GDI being asked to choose, and Win98 chose its UI
    ;; face. MS Sans Serif is bundled as a .FON, so this answer needs no font
    ;; file to load and no host font to exist — which is what makes it safe to
    ;; have no Canvas path left underneath.
    (drop (call $gdi_bitmap_font_ensure_ms_sans))
    (call $gdi_bitmap_font_best
      (i32.const 0x07F0A53C) (call $gdi_font_height (local.get $handle))))

  (func $gdi_bitmap_font_height (param $hdc i32) (param $strike i32) (result i32)
    (local $dc i32) (local $handle i32) (local $object i32)
    (local $height i32) (local $request i32) (local $win i32) (local $vp i32)
    (local.set $dc (call $gdi_dc_state_entry (local.get $hdc) (i32.const 0)))
    (local.set $handle (i32.load offset=88 (local.get $dc)))
    (local.set $object (call $gdi_object_record (local.get $handle)))
    (if (local.get $object)
      (then
        (local.set $request (i32.load offset=8 (local.get $object)))
        (local.set $height (local.get $request))
        ;; Negative LOGFONT heights request character height. Bitmap selection
        ;; returns a complete cell. Fixedsys exposes the same integer-scaled
        ;; cells measured on native Win98 even though Wine stores one 8x15 base.
        (if (i32.lt_s (local.get $request) (i32.const 0))
          (then
            (local.set $request (i32.sub (i32.const 0) (local.get $request)))
            (if (call $gdi_bitmap_font_face_equal
                  (i32.add (i32.load offset=8 (local.get $strike))
                    (i32.load offset=56 (local.get $strike)))
                  (i32.const 0x07F0A528))
              (then
                (local.set $height
                  (if (result i32) (i32.le_s (local.get $request) (i32.const 18))
                    (then (i32.const 15))
                    (else
                      (if (result i32) (i32.le_s (local.get $request) (i32.const 36))
                        (then (i32.const 30))
                        (else
                          (if (result i32) (i32.le_s (local.get $request) (i32.const 54))
                            (then (i32.const 60))
                            (else
                              (if (result i32) (i32.le_s (local.get $request) (i32.const 66))
                                (then (i32.const 75))
                                (else (i32.const 90)))))))))))
              (else (local.set $height (i32.load offset=20 (local.get $strike))))))))
      (else
        ;; Exact native stock cells measured by the v86 Win98 reference probe.
        (local.set $height
          (if (result i32) (i32.eq (local.get $handle) (i32.const 0x3001B))
            (then (i32.const 13))
            (else
              (if (result i32) (i32.eq (local.get $handle) (i32.const 0x3001D))
                (then (i32.const 16))
                (else
                  (if (result i32) (i32.eq
                        (local.get $handle) (i32.const 0x3001A))
                    (then (i32.const 12))
                    (else
                      (if (result i32) (i32.eq
                            (local.get $handle) (i32.const 0x30020))
                        (then (i32.const 15))
                        (else (i32.const 13))))))))))))
    (if (i32.lt_s (local.get $height) (i32.const 0))
      (then (local.set $height (i32.sub (i32.const 0) (local.get $height)))))
    (if (i32.eqz (local.get $height))
      (then (local.set $height (i32.load offset=20 (local.get $strike)))))
    (local.set $win (i32.load offset=52 (local.get $dc)))
    (local.set $vp (i32.load offset=68 (local.get $dc)))
    (if (i32.lt_s (local.get $vp) (i32.const 0))
      (then (local.set $vp (i32.sub (i32.const 0) (local.get $vp)))))
    (if (i32.lt_s (local.get $win) (i32.const 0))
      (then (local.set $win (i32.sub (i32.const 0) (local.get $win)))))
    (if (i32.and (i32.ne (local.get $win) (i32.const 0))
          (i32.ne (local.get $vp) (i32.const 0)))
      (then (local.set $height (call $gdi_round_ratio
        (i64.mul (i64.extend_i32_u (local.get $height)) (i64.extend_i32_u (local.get $vp)))
        (i64.extend_i32_u (local.get $win))))))
    (if (i32.gt_s (local.get $height) (i32.const 4096))
      (then (local.set $height (i32.const 4096))))
    (select (local.get $height) (i32.const 1) (i32.gt_s (local.get $height) (i32.const 0))))

  (func $gdi_bitmap_font_width_height (param $strike i32) (param $height i32)
        (result i32)
    ;; Native Fixedsys reaches 40x90 at the largest common size: 5x
    ;; horizontally and 6x vertically from its 8x15 base strike.
    (if (i32.and (i32.eq (local.get $height) (i32.const 90))
          (call $gdi_bitmap_font_face_equal
            (i32.add (i32.load offset=8 (local.get $strike))
              (i32.load offset=56 (local.get $strike)))
            (i32.const 0x07F0A528)))
      (then (return (i32.const 75))))
    (local.get $height))

  (func $gdi_bitmap_font_glyph (param $strike i32) (param $code i32) (result i32)
    (local $first i32) (local $last i32) (local $version i32) (local $entry_size i32)
    (local.set $first (i32.load offset=36 (local.get $strike)))
    (local.set $last (i32.load offset=40 (local.get $strike)))
    (if (i32.or (i32.lt_u (local.get $code) (local.get $first))
          (i32.gt_u (local.get $code) (local.get $last)))
      (then (local.set $code (i32.load offset=44 (local.get $strike)))))
    (if (i32.or (i32.lt_u (local.get $code) (local.get $first))
          (i32.gt_u (local.get $code) (local.get $last)))
      (then (local.set $code (local.get $first))))
    (local.set $version (i32.load offset=16 (local.get $strike)))
    (local.set $entry_size (select (i32.const 4) (i32.const 6)
      (i32.eq (local.get $version) (i32.const 0x0200))))
    (i32.add (i32.load offset=8 (local.get $strike))
      (i32.add (select (i32.const 118) (i32.const 148)
          (i32.eq (local.get $version) (i32.const 0x0200)))
        (i32.mul (i32.sub (local.get $code) (local.get $first)) (local.get $entry_size)))))

  (func $gdi_bitmap_font_scaled_width (param $strike i32) (param $glyph i32)
        (param $height i32) (result i32)
    (local $width i32)
    (local.set $height (call $gdi_bitmap_font_width_height
      (local.get $strike) (local.get $height)))
    (local.set $width (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_u (i32.load16_u (local.get $glyph)))
        (i64.extend_i32_u (local.get $height)))
      (i64.extend_i32_u (i32.load offset=20 (local.get $strike)))))
    (select (local.get $width) (i32.const 1) (i32.gt_s (local.get $width) (i32.const 0))))

  (func $gdi_bitmap_font_glyph_pixel (param $strike i32) (param $glyph_offset i32)
        (param $native_width i32) (param $native_height i32)
        (param $width i32) (param $height i32) (param $x i32) (param $y i32)
        (result i32)
    (local $sx i32) (local $sy i32)
    (if (i32.or (i32.ge_u (local.get $x) (local.get $width))
          (i32.ge_u (local.get $y) (local.get $height)))
      (then (return (i32.const 0))))
    (local.set $sx (i32.div_u
      (i32.mul (local.get $x) (local.get $native_width)) (local.get $width)))
    (local.set $sy (i32.div_u
      (i32.mul (local.get $y) (local.get $native_height)) (local.get $height)))
    (i32.ne (i32.and
      (i32.load8_u (i32.add
        (i32.add (i32.load offset=8 (local.get $strike)) (local.get $glyph_offset))
        (i32.add (i32.mul (i32.shr_u (local.get $sx) (i32.const 3))
                    (local.get $native_height))
          (local.get $sy))))
      (i32.shl (i32.const 1)
        (i32.sub (i32.const 7) (i32.and (local.get $sx) (i32.const 7)))))
      (i32.const 0)))

  ;; Return -2 when no bitmap strike is selected so the public handler can
  ;; retain Canvas only as the scalable-font fallback. Selected FNT strikes
  ;; implement GGO_METRICS and DWORD-aligned monochrome GGO_BITMAP in WAT.
  (func $gdi_bitmap_glyph_outline_a (param $hdc i32) (param $character i32)
        (param $format i32) (param $metrics_out i32) (param $buffer_size i32)
        (param $buffer i32) (param $mat2 i32) (result i32)
    (local $strike i32) (local $glyph i32) (local $glyph_offset i32)
    (local $base_format i32) (local $native_width i32) (local $native_height i32)
    (local $width i32) (local $height i32) (local $ascent i32)
    (local $x i32) (local $y i32) (local $min_x i32) (local $min_y i32)
    (local $max_x i32) (local $max_y i32) (local $black_width i32)
    (local $black_height i32) (local $stride i32) (local $required i32)
    (local $output_x i32) (local $output_y i32) (local $byte i32)
    (local.set $strike (call $gdi_bitmap_font_selected (local.get $hdc)))
    (if (i32.eqz (local.get $strike)) (then (return (i32.const -2))))
    (if (i32.eqz (local.get $metrics_out)) (then (return (i32.const -1))))
    (local.set $base_format (i32.and (local.get $format) (i32.const 0xFF)))
    ;; GGO_UNHINTED has no effect on an already-rasterized bitmap strike.
    (if (i32.or (i32.gt_u (local.get $base_format) (i32.const 1))
          (i32.ne (i32.and (local.get $format) (i32.const -257))
            (local.get $base_format)))
      (then (return (i32.const -1))))
    ;; Null historically behaved as identity in this emulator. Honor a supplied
    ;; identity MAT2, but reject transforms until the bitmap transformer exists.
    (if (local.get $mat2)
      (then
        (if (i32.or
              (i32.ne (i32.load (local.get $mat2)) (i32.const 0x00010000))
              (i32.or
                (i32.ne (i32.load offset=4 (local.get $mat2)) (i32.const 0))
                (i32.or
                  (i32.ne (i32.load offset=8 (local.get $mat2)) (i32.const 0))
                  (i32.ne (i32.load offset=12 (local.get $mat2))
                    (i32.const 0x00010000)))))
          (then (return (i32.const -1))))))
    (local.set $glyph (call $gdi_bitmap_font_glyph
      (local.get $strike) (i32.and (local.get $character) (i32.const 0xFF))))
    (local.set $native_width (i32.load16_u (local.get $glyph)))
    (local.set $native_height (i32.load offset=20 (local.get $strike)))
    (local.set $height (call $gdi_bitmap_font_height
      (local.get $hdc) (local.get $strike)))
    (local.set $width (call $gdi_bitmap_font_scaled_width
      (local.get $strike) (local.get $glyph) (local.get $height)))
    (if (i32.or (i32.gt_u (local.get $width) (i32.const 4096))
          (i32.gt_u (local.get $height) (i32.const 4096)))
      (then (return (i32.const -1))))
    (local.set $glyph_offset (select (i32.load16_u offset=2 (local.get $glyph))
      (i32.load offset=2 (local.get $glyph))
      (i32.eq (i32.load offset=16 (local.get $strike)) (i32.const 0x0200))))
    (local.set $min_x (local.get $width))
    (local.set $min_y (local.get $height))
    (local.set $max_x (i32.const -1))
    (local.set $max_y (i32.const -1))
    (block $scan_done (loop $scan_rows
      (br_if $scan_done (i32.ge_u (local.get $y) (local.get $height)))
      (local.set $x (i32.const 0))
      (block $row_done (loop $scan_row
        (br_if $row_done (i32.ge_u (local.get $x) (local.get $width)))
        (if (call $gdi_bitmap_font_glyph_pixel
              (local.get $strike) (local.get $glyph_offset)
              (local.get $native_width) (local.get $native_height)
              (local.get $width) (local.get $height) (local.get $x) (local.get $y))
          (then
            (if (i32.lt_u (local.get $x) (local.get $min_x))
              (then (local.set $min_x (local.get $x))))
            (if (i32.lt_u (local.get $y) (local.get $min_y))
              (then (local.set $min_y (local.get $y))))
            (if (i32.gt_s (local.get $x) (local.get $max_x))
              (then (local.set $max_x (local.get $x))))
            (if (i32.gt_s (local.get $y) (local.get $max_y))
              (then (local.set $max_y (local.get $y))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $scan_row)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $scan_rows)))
    (if (i32.ge_s (local.get $max_x) (i32.const 0))
      (then
        (local.set $black_width
          (i32.add (i32.sub (local.get $max_x) (local.get $min_x)) (i32.const 1)))
        (local.set $black_height
          (i32.add (i32.sub (local.get $max_y) (local.get $min_y)) (i32.const 1)))
        (local.set $ascent (call $gdi_round_ratio
          (i64.mul (i64.extend_i32_u (i32.load offset=24 (local.get $strike)))
            (i64.extend_i32_u (local.get $height)))
          (i64.extend_i32_u (local.get $native_height))))))
    (i32.store (local.get $metrics_out) (local.get $black_width))
    (i32.store offset=4 (local.get $metrics_out) (local.get $black_height))
    (i32.store offset=8 (local.get $metrics_out)
      (select (local.get $min_x) (i32.const 0) (i32.gt_s (local.get $black_width) (i32.const 0))))
    (i32.store offset=12 (local.get $metrics_out)
      (select (i32.sub (local.get $ascent) (local.get $min_y)) (i32.const 0)
        (i32.gt_s (local.get $black_height) (i32.const 0))))
    (i32.store16 offset=16 (local.get $metrics_out) (local.get $width))
    (i32.store16 offset=18 (local.get $metrics_out) (i32.const 0))
    (if (i32.eqz (local.get $base_format)) (then (return (i32.const 0))))
    (local.set $stride (i32.and
      (i32.add (local.get $black_width) (i32.const 31)) (i32.const -32)))
    (local.set $stride (i32.shr_u (local.get $stride) (i32.const 3)))
    (local.set $required (i32.mul (local.get $stride) (local.get $black_height)))
    (if (i32.or (i32.eqz (local.get $required))
          (i32.or (i32.eqz (local.get $buffer_size)) (i32.eqz (local.get $buffer))))
      (then (return (local.get $required))))
    (if (i32.lt_u (local.get $buffer_size) (local.get $required))
      (then (return (i32.const -1))))
    (memory.fill (local.get $buffer) (i32.const 0) (local.get $required))
    (local.set $y (local.get $min_y))
    (block $write_done (loop $write_rows
      (br_if $write_done (i32.gt_s (local.get $y) (local.get $max_y)))
      (local.set $x (local.get $min_x))
      (block $write_row_done (loop $write_row
        (br_if $write_row_done (i32.gt_s (local.get $x) (local.get $max_x)))
        (if (call $gdi_bitmap_font_glyph_pixel
              (local.get $strike) (local.get $glyph_offset)
              (local.get $native_width) (local.get $native_height)
              (local.get $width) (local.get $height) (local.get $x) (local.get $y))
          (then
            (local.set $output_x (i32.sub (local.get $x) (local.get $min_x)))
            (local.set $output_y (i32.sub (local.get $y) (local.get $min_y)))
            (local.set $byte (i32.add (local.get $buffer)
              (i32.add (i32.mul (local.get $output_y) (local.get $stride))
                (i32.shr_u (local.get $output_x) (i32.const 3)))))
            (i32.store8 (local.get $byte)
              (i32.or (i32.load8_u (local.get $byte))
                (i32.shr_u (i32.const 0x80)
                  (i32.and (local.get $output_x) (i32.const 7)))))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $write_row)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $write_rows)))
    (local.get $required))

  (func $gdi_font_character_width (param $hdc i32) (param $character i32)
        (param $wide i32) (result i32)
    (local $strike i32) (local $glyph i32) (local $height i32)
    (local.set $strike (call $gdi_bitmap_font_selected (local.get $hdc)))
    (if (local.get $strike)
      (then
        (local.set $glyph (call $gdi_bitmap_font_glyph
          (local.get $strike) (i32.and (local.get $character) (i32.const 0xFF))))
        (local.set $height (call $gdi_bitmap_font_height
          (local.get $hdc) (local.get $strike)))
        (return (call $gdi_bitmap_font_scaled_width
          (local.get $strike) (local.get $glyph) (local.get $height)))))
    (if (local.get $wide)
      (then
        (i32.store16 (global.get $TEXT_SCRATCH) (local.get $character))
        (i32.store16 offset=2 (global.get $TEXT_SCRATCH) (i32.const 0)))
      (else
        (i32.store8 (global.get $TEXT_SCRATCH) (local.get $character))
        (i32.store8 offset=1 (global.get $TEXT_SCRATCH) (i32.const 0))))
    (call $host_measure_text (local.get $hdc) (global.get $TEXT_SCRATCH)
      (i32.const 1) (local.get $wide)))

  ;; GetCharWidth/GetCharWidth32 share the same selected-font semantics. FNT
  ;; advances never cross the host boundary; scalable faces use Canvas only as
  ;; their font provider, while range validation and output storage stay in WAT.
  (func $gdi_font_char_widths (param $hdc i32) (param $first i32)
        (param $last i32) (param $output i32) (param $wide i32) (result i32)
    (local $count i32) (local $i i32)
    (if (i32.or (i32.eqz (local.get $output))
          (i32.or (i32.gt_u (local.get $first) (local.get $last))
            (i32.gt_u (i32.sub (local.get $last) (local.get $first))
              (i32.const 65535))))
      (then (return (i32.const 0))))
    (local.set $count
      (i32.add (i32.sub (local.get $last) (local.get $first)) (i32.const 1)))
    (block $done (loop $characters
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (i32.store (i32.add (local.get $output) (i32.shl (local.get $i) (i32.const 2)))
        (call $gdi_font_character_width (local.get $hdc)
          (i32.add (local.get $first) (local.get $i)) (local.get $wide)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $characters)))
    (i32.const 1))

  ;; Deterministic Latin/SBCS placement. WAT owns the GCP_RESULTSW contract and
  ;; all arrays. The selected font provider supplies only integer advances:
  ;; bitmap FNT in WAT, or Canvas measurement for a scalable fallback face.
  (func $gdi_character_placement_w (param $hdc i32) (param $text i32)
        (param $count i32) (param $max_extent i32) (param $results i32)
        (param $flags i32) (result i32)
    (local $capacity i32) (local $limit i32) (local $i i32) (local $included i32)
    (local $character i32) (local $width i32) (local $extent i32) (local $height i32)
    (local $out_string i32) (local $order i32) (local $dx i32)
    (local $caret i32) (local $class i32) (local $glyphs i32)
    (local $strike i32) (local $packed i32) (local $justification i32)
    (local $extra i32) (local $share i32) (local $remainder i32)
    (if (i32.or (i32.eqz (local.get $results))
          (i32.or (i32.lt_s (local.get $count) (i32.const 0))
            (i32.or (i32.gt_u (local.get $count) (i32.const 65536))
              (i32.and (i32.gt_u (local.get $count) (i32.const 0))
                (i32.eqz (local.get $text))))))
      (then (return (i32.const 0))))
    (if (i32.lt_u (i32.load (local.get $results)) (i32.const 36))
      (then (return (i32.const 0))))
    (local.set $capacity (i32.load offset=28 (local.get $results)))
    (local.set $limit (select (local.get $capacity) (local.get $count)
      (i32.lt_u (local.get $capacity) (local.get $count))))
    (local.set $out_string (i32.load offset=4 (local.get $results)))
    (local.set $order (i32.load offset=8 (local.get $results)))
    (local.set $dx (i32.load offset=12 (local.get $results)))
    (local.set $caret (i32.load offset=16 (local.get $results)))
    (local.set $class (i32.load offset=20 (local.get $results)))
    (local.set $glyphs (i32.load offset=24 (local.get $results)))
    (if (local.get $out_string) (then (local.set $out_string (call $g2w (local.get $out_string)))))
    (if (local.get $order) (then (local.set $order (call $g2w (local.get $order)))))
    (if (local.get $dx) (then (local.set $dx (call $g2w (local.get $dx)))))
    (if (local.get $caret) (then (local.set $caret (call $g2w (local.get $caret)))))
    (if (local.get $class) (then (local.set $class (call $g2w (local.get $class)))))
    (if (local.get $glyphs) (then (local.set $glyphs (call $g2w (local.get $glyphs)))))
    (block $done (loop $characters
      (br_if $done (i32.ge_u (local.get $i) (local.get $limit)))
      (local.set $character
        (i32.load16_u (i32.add (local.get $text) (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $width (call $gdi_font_character_width
        (local.get $hdc) (local.get $character) (i32.const 1)))
      ;; GCP_MAXEXTENT stops before the first character that would exceed the
      ;; caller's logical extent. Other flags do not truncate the input.
      (if (i32.and (i32.ne (i32.and (local.get $flags) (i32.const 0x00100000))
                    (i32.const 0))
            (i32.gt_s (i32.add (local.get $extent) (local.get $width))
              (local.get $max_extent)))
        (then (br $done)))
      (if (local.get $out_string)
        (then (i32.store16
          (i32.add (local.get $out_string) (i32.shl (local.get $included) (i32.const 1)))
          (local.get $character))))
      (if (local.get $order)
        (then (i32.store
          (i32.add (local.get $order) (i32.shl (local.get $included) (i32.const 2)))
          (local.get $i))))
      (if (local.get $dx)
        (then (i32.store
          (i32.add (local.get $dx) (i32.shl (local.get $included) (i32.const 2)))
          (local.get $width))))
      (if (local.get $caret)
        (then (i32.store
          (i32.add (local.get $caret) (i32.shl (local.get $included) (i32.const 2)))
          (local.get $extent))))
      ;; GCP_CLASSIN preserves nonzero caller classifications. Otherwise Latin
      ;; is the deterministic classification for this SBCS placement backend.
      (if (local.get $class)
        (then
          (if (i32.or
                (i32.eqz (i32.and (local.get $flags) (i32.const 0x00080000)))
                (i32.eqz (i32.load8_u (i32.add (local.get $class) (local.get $included)))))
            (then (i32.store8
              (i32.add (local.get $class) (local.get $included)) (i32.const 1))))))
      (if (local.get $glyphs)
        (then (i32.store16
          (i32.add (local.get $glyphs) (i32.shl (local.get $included) (i32.const 1)))
          (local.get $character))))
      (local.set $extent (i32.add (local.get $extent) (local.get $width)))
      (local.set $included (i32.add (local.get $included) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $characters)))
    ;; Simple Latin justification distributes the requested remainder across
    ;; emitted advances. Complex-script justification remains a font fallback.
    (local.set $justification (i32.and
      (i32.eq (i32.and (local.get $flags) (i32.const 0x00110000))
        (i32.const 0x00110000))
      (i32.and (i32.ne (local.get $dx) (i32.const 0))
        (i32.gt_u (local.get $included) (i32.const 0)))))
    (if (i32.and (local.get $justification)
          (i32.gt_s (local.get $max_extent) (local.get $extent)))
      (then
        (local.set $extra (i32.sub (local.get $max_extent) (local.get $extent)))
        (local.set $share (i32.div_u (local.get $extra) (local.get $included)))
        (local.set $remainder (i32.rem_u (local.get $extra) (local.get $included)))
        (local.set $i (i32.const 0))
        (block $justify_done (loop $justify
          (br_if $justify_done (i32.ge_u (local.get $i) (local.get $included)))
          (i32.store (i32.add (local.get $dx) (i32.shl (local.get $i) (i32.const 2)))
            (i32.add
              (i32.load (i32.add (local.get $dx) (i32.shl (local.get $i) (i32.const 2))))
              (i32.add (local.get $share)
                (i32.lt_u (local.get $i) (local.get $remainder)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $justify)))
        (local.set $extent (local.get $max_extent))))
    (i32.store offset=28 (local.get $results) (local.get $included))
    (i32.store offset=32 (local.get $results) (local.get $included))
    (local.set $strike (call $gdi_bitmap_font_selected (local.get $hdc)))
    (if (local.get $strike)
      (then (local.set $height (call $gdi_bitmap_font_height
        (local.get $hdc) (local.get $strike))))
      (else
        (local.set $packed (call $host_get_text_metrics (local.get $hdc)))
        (local.set $height (i32.and (local.get $packed) (i32.const 0xFFFF)))))
    (i32.or (i32.and (local.get $extent) (i32.const 0xFFFF))
      (i32.shl (i32.and (local.get $height) (i32.const 0xFFFF)) (i32.const 16))))

  (func $gdi_bitmap_text_measure (param $hdc i32) (param $text i32)
        (param $count i32) (param $wide i32) (result i32)
    (local $strike i32) (local $height i32) (local $i i32) (local $code i32) (local $width i32)
    (local.set $strike (call $gdi_bitmap_font_selected (local.get $hdc)))
    (if (i32.eqz (local.get $strike)) (then (return (i32.const -1))))
    (if (i32.or (i32.lt_s (local.get $count) (i32.const 0))
          (i32.or (i32.gt_u (local.get $count) (i32.const 65536))
            (i32.and (i32.gt_s (local.get $count) (i32.const 0))
              (i32.eqz (local.get $text)))))
      (then (return (i32.const 0))))
    (if (i32.le_s (local.get $count) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $height (call $gdi_bitmap_font_height (local.get $hdc) (local.get $strike)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $code (select
        (i32.load8_u (i32.add (local.get $text) (local.get $i)))
        (i32.and (i32.load16_u (i32.add (local.get $text) (i32.shl (local.get $i) (i32.const 1)))) (i32.const 0xFF))
        (i32.eqz (local.get $wide))))
      (local.set $width (i32.add (local.get $width)
        (call $gdi_bitmap_font_scaled_width (local.get $strike)
          (call $gdi_bitmap_font_glyph (local.get $strike) (local.get $code)) (local.get $height))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $width))

  (func $gdi_bitmap_text_metrics (param $hdc i32) (result i32)
    (local $strike i32) (local $height i32) (local $average i32)
    (local.set $strike (call $gdi_bitmap_font_selected (local.get $hdc)))
    (if (i32.eqz (local.get $strike)) (then (return (i32.const -1))))
    (local.set $height (call $gdi_bitmap_font_height (local.get $hdc) (local.get $strike)))
    (local.set $average (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_u (i32.load offset=28 (local.get $strike)))
        (i64.extend_i32_u (call $gdi_bitmap_font_width_height
          (local.get $strike) (local.get $height))))
      (i64.extend_i32_u (i32.load offset=20 (local.get $strike)))))
    (i32.or (i32.and (local.get $height) (i32.const 0xFFFF))
      (i32.shl (i32.and (local.get $average) (i32.const 0xFFFF)) (i32.const 16))))

  (func $gdi_bitmap_text_pixel (param $hdc i32) (param $desc i32)
        (param $x i32) (param $y i32) (param $color i32) (result i32)
    (if (i32.or (i32.lt_s (local.get $x) (i32.const 0))
          (i32.or (i32.ge_s (local.get $x) (i32.load offset=4 (local.get $desc)))
            (i32.or (i32.lt_s (local.get $y) (i32.const 0))
              (i32.ge_s (local.get $y) (i32.load offset=8 (local.get $desc))))))
      (then (return (i32.const 0))))
    (if (i32.eqz (call $gdi_raster_clip_visible
          (local.get $hdc) (local.get $desc) (local.get $x) (local.get $y)))
      (then (return (i32.const 0))))
    (call $gdi_raster_write (local.get $desc) (local.get $x) (local.get $y) (local.get $color)))

  (func $gdi_bitmap_text_pixel_rect (param $hdc i32) (param $desc i32)
        (param $x i32) (param $y i32) (param $color i32)
        (param $clip i32) (param $clip_left i32) (param $clip_top i32)
        (param $clip_right i32) (param $clip_bottom i32) (result i32)
    (if (i32.and (local.get $clip)
          (i32.or (i32.lt_s (local.get $x) (local.get $clip_left))
            (i32.or (i32.ge_s (local.get $x) (local.get $clip_right))
              (i32.or (i32.lt_s (local.get $y) (local.get $clip_top))
                (i32.ge_s (local.get $y) (local.get $clip_bottom))))))
      (then (return (i32.const 0))))
    (call $gdi_bitmap_text_pixel (local.get $hdc) (local.get $desc)
      (local.get $x) (local.get $y) (local.get $color)))

  (func $gdi_bitmap_text_fill (param $hdc i32) (param $desc i32)
        (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
        (param $color i32) (param $clip i32)
        (param $clip_left i32) (param $clip_top i32)
        (param $clip_right i32) (param $clip_bottom i32)
    (local $x i32) (local $y i32)
    (if (i32.lt_s (local.get $left) (i32.const 0))
      (then (local.set $left (i32.const 0))))
    (if (i32.lt_s (local.get $top) (i32.const 0))
      (then (local.set $top (i32.const 0))))
    (if (i32.gt_s (local.get $right) (i32.load offset=4 (local.get $desc)))
      (then (local.set $right (i32.load offset=4 (local.get $desc)))))
    (if (i32.gt_s (local.get $bottom) (i32.load offset=8 (local.get $desc)))
      (then (local.set $bottom (i32.load offset=8 (local.get $desc)))))
    (local.set $y (local.get $top))
    (block $done (loop $rows
      (br_if $done (i32.ge_s (local.get $y) (local.get $bottom)))
      (local.set $x (local.get $left))
      (block $row_done (loop $row
        (br_if $row_done (i32.ge_s (local.get $x) (local.get $right)))
        (drop (call $gdi_bitmap_text_pixel_rect (local.get $hdc) (local.get $desc)
          (local.get $x) (local.get $y) (local.get $color)
          (local.get $clip) (local.get $clip_left) (local.get $clip_top)
          (local.get $clip_right) (local.get $clip_bottom)))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $row)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows))))

  (func $gdi_bitmap_text_scale_x_delta (param $desc i32) (param $delta i32) (result i32)
    (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $delta))
        (i64.extend_i32_s (i32.load offset=56 (local.get $desc))))
      (i64.extend_i32_s (i32.load offset=40 (local.get $desc)))))

  (func $gdi_bitmap_text_device_x_delta (param $desc i32) (param $delta i32) (result i32)
    (local $value i32)
    (local.set $value (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $delta))
        (i64.extend_i32_s (i32.load offset=40 (local.get $desc))))
      (i64.extend_i32_s (i32.load offset=56 (local.get $desc)))))
    (if (result i32) (i32.lt_s (local.get $value) (i32.const 0))
      (then (i32.sub (i32.const 0) (local.get $value)))
      (else (local.get $value))))

  (func $gdi_bitmap_text_device_y_delta (param $desc i32) (param $delta i32) (result i32)
    (local $value i32)
    (local.set $value (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $delta))
        (i64.extend_i32_s (i32.load offset=44 (local.get $desc))))
      (i64.extend_i32_s (i32.load offset=60 (local.get $desc)))))
    (if (result i32) (i32.lt_s (local.get $value) (i32.const 0))
      (then (i32.sub (i32.const 0) (local.get $value)))
      (else (local.get $value))))

  (func $gdi_bitmap_text_unmap_y (param $desc i32) (param $device_y i32) (result i32)
    (i32.add (i32.load offset=36 (local.get $desc))
      (call $gdi_round_ratio
        (i64.mul
          (i64.extend_i32_s (i32.sub (local.get $device_y)
            (i32.add (i32.load offset=76 (local.get $desc))
              (i32.load offset=52 (local.get $desc)))))
          (i64.extend_i32_s (i32.load offset=44 (local.get $desc))))
        (i64.extend_i32_s (i32.load offset=60 (local.get $desc))))))

  (func $gdi_bitmap_text_character (param $text i32) (param $index i32)
        (param $wide i32) (result i32)
    (if (result i32) (local.get $wide)
      (then (i32.load16_u (i32.add (local.get $text)
        (i32.shl (local.get $index) (i32.const 1)))))
      (else (i32.load8_u (i32.add (local.get $text) (local.get $index))))))

  ;; DrawText uses a private WCHAR presentation buffer. Mnemonic prefixes are
  ;; removed and && becomes literal &. A parallel byte array marks accelerator
  ;; underlines without stealing a WCHAR bit, so scalable UTF-16 stays intact.
  ;; Four spare WCHARs accommodate the three-dot ellipsis and terminator.
  (global $GDI_BITMAP_TEXT_LAYOUT i32 (i32.const 0x07993000))
  (global $GDI_BITMAP_TEXT_LAYOUT_SIZE i32 (i32.const 0x00021000))
  (global $GDI_BITMAP_TEXT_LAYOUT_CHARS i32 (i32.const 65540))
  (global $GDI_BITMAP_TEXT_PREFIX i32 (i32.const 0x079B4000))
  (global $GDI_BITMAP_TEXT_PREFIX_SIZE i32 (i32.const 0x00011000))
  (global $gdi_bitmap_text_active_tab_width (mut i32) (i32.const 0))
  (global $gdi_bitmap_draw_text_tab_chars (mut i32) (i32.const 0))

  (func $gdi_bitmap_text_prefix_address (param $text i32) (param $index i32)
        (result i32)
    (if (i32.or (i32.lt_u (local.get $text) (global.get $GDI_BITMAP_TEXT_LAYOUT))
          (i32.ge_u (local.get $text)
            (i32.add (global.get $GDI_BITMAP_TEXT_LAYOUT)
              (global.get $GDI_BITMAP_TEXT_LAYOUT_SIZE))))
      (then (return (i32.const 0))))
    (i32.add (global.get $GDI_BITMAP_TEXT_PREFIX)
      (i32.add (i32.shr_u
        (i32.sub (local.get $text) (global.get $GDI_BITMAP_TEXT_LAYOUT))
        (i32.const 1)) (local.get $index))))

  (func $gdi_bitmap_text_is_prefix (param $text i32) (param $index i32)
        (result i32)
    (local $address i32)
    (local.set $address (call $gdi_bitmap_text_prefix_address
      (local.get $text) (local.get $index)))
    (if (result i32) (local.get $address)
      (then (i32.ne (i32.load8_u (local.get $address)) (i32.const 0)))
      (else (i32.const 0))))

  (func $gdi_bitmap_text_scale_y_delta (param $desc i32) (param $delta i32)
        (result i32)
    (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $delta))
        (i64.extend_i32_s (i32.load offset=60 (local.get $desc))))
      (i64.extend_i32_s (i32.load offset=44 (local.get $desc)))))

  (func $gdi_bitmap_text_prepare_layout (param $text i32) (param $count i32)
        (param $wide i32) (param $format i32) (result i32)
    (local $i i32) (local $out i32) (local $ch i32) (local $next i32)
    (local $prefix i32)
    (if (i32.gt_u (local.get $count)
          (i32.sub (global.get $GDI_BITMAP_TEXT_LAYOUT_CHARS) (i32.const 4)))
      (then (return (i32.const -1))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $prefix (i32.const 0))
      (local.set $ch (call $gdi_bitmap_text_character
        (local.get $text) (local.get $i) (local.get $wide)))
      (if (i32.and
            (i32.eqz (i32.and (local.get $format) (i32.const 0x800)))
            (i32.and (i32.eq (local.get $ch) (i32.const 38))
              (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $count))))
        (then
          (local.set $next (call $gdi_bitmap_text_character
            (local.get $text) (i32.add (local.get $i) (i32.const 1)) (local.get $wide)))
          (if (i32.eq (local.get $next) (i32.const 38))
            (then (local.set $ch (i32.const 38)))
            (else
              (local.set $ch (local.get $next))
              (local.set $prefix (i32.const 1))))
          (local.set $i (i32.add (local.get $i) (i32.const 2))))
        (else (local.set $i (i32.add (local.get $i) (i32.const 1)))))
      (i32.store16 (i32.add (global.get $GDI_BITMAP_TEXT_LAYOUT)
        (i32.shl (local.get $out) (i32.const 1))) (local.get $ch))
      (i32.store8 (i32.add (global.get $GDI_BITMAP_TEXT_PREFIX) (local.get $out))
        (local.get $prefix))
      (local.set $out (i32.add (local.get $out) (i32.const 1)))
      (br $copy)))
    (i32.store16 (i32.add (global.get $GDI_BITMAP_TEXT_LAYOUT)
      (i32.shl (local.get $out) (i32.const 1))) (i32.const 0))
    (i32.store8 (i32.add (global.get $GDI_BITMAP_TEXT_PREFIX) (local.get $out))
      (i32.const 0))
    (local.get $out))

  (func $gdi_bitmap_text_tab_width (param $hdc i32) (param $strike i32)
        (param $format i32) (result i32)
    (local $height i32) (local $average i32) (local $chars i32)
    (if (i32.eqz (i32.and (local.get $format) (i32.const 0x40)))
      (then (return (i32.const 0))))
    (local.set $chars (i32.const 8))
    (if (i32.gt_s (global.get $gdi_bitmap_draw_text_tab_chars) (i32.const 0))
      (then (local.set $chars (global.get $gdi_bitmap_draw_text_tab_chars)))
      (else
        (if (i32.ne (i32.and (local.get $format) (i32.const 0x80)) (i32.const 0))
          (then
            (local.set $chars
              (i32.and (i32.shr_u (local.get $format) (i32.const 8)) (i32.const 0xFF)))
            (if (i32.eqz (local.get $chars))
              (then (local.set $chars (i32.const 8))))))))
    (if (local.get $strike)
      (then
        (local.set $height (call $gdi_bitmap_font_height
          (local.get $hdc) (local.get $strike)))
        (local.set $average (call $gdi_round_ratio
          (i64.mul (i64.extend_i32_u (i32.load offset=28 (local.get $strike)))
            (i64.extend_i32_u (call $gdi_bitmap_font_width_height
              (local.get $strike) (local.get $height))))
          (i64.extend_i32_u (i32.load offset=20 (local.get $strike))))))
      (else
        (local.set $average (i32.shr_u
          (call $host_get_text_metrics (local.get $hdc)) (i32.const 16)))))
    (if (i32.le_s (local.get $average) (i32.const 0))
      (then (local.set $average (i32.const 1))))
    (i32.mul (local.get $average) (local.get $chars)))

  ;; DrawTextA/W encode a DT_TABSTOP character count in bits 8..15.
  (func $gdi_bitmap_text_consume_tabstop (param $format i32) (result i32)
    (if (result i32)
      (i32.ne (i32.and (local.get $format) (i32.const 0x80)) (i32.const 0))
      (then (i32.and (local.get $format) (i32.const 0xFFFF00FF)))
      (else (local.get $format))))

  (func $gdi_bitmap_text_next_tab (param $cursor i32) (param $origin i32)
        (param $tab_width i32) (result i32)
    (local $relative i32)
    (if (i32.le_s (local.get $tab_width) (i32.const 0))
      (then (return (local.get $cursor))))
    (local.set $relative (i32.sub (local.get $cursor) (local.get $origin)))
    (if (i32.lt_s (local.get $relative) (i32.const 0))
      (then (local.set $relative (i32.const 0))))
    (i32.add (local.get $origin)
      (i32.mul (i32.add (i32.div_s (local.get $relative) (local.get $tab_width))
        (i32.const 1)) (local.get $tab_width))))

  (func $gdi_bitmap_text_layout_measure (param $hdc i32) (param $text i32)
        (param $count i32) (param $wide i32) (param $tab_width i32) (result i32)
    (local $i i32) (local $width i32) (local $ch i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $ch (call $gdi_bitmap_text_character
        (local.get $text) (local.get $i) (local.get $wide)))
      (if (i32.and (i32.ne (local.get $tab_width) (i32.const 0))
            (i32.eq (local.get $ch) (i32.const 9)))
        (then (local.set $width (call $gdi_bitmap_text_next_tab
          (local.get $width) (i32.const 0) (local.get $tab_width))))
        (else (local.set $width (i32.add (local.get $width)
          (call $gdi_font_character_width
            (local.get $hdc) (local.get $ch) (local.get $wide))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $width))

  ;; Ellipsify one prepared WCHAR line in place. Path ellipsis preserves the
  ;; final slash and tail; end/word ellipsis shortens the visible end.
  (func $gdi_bitmap_text_ellipsify (param $hdc i32) (param $text i32)
        (param $count i32) (param $max_width i32) (param $format i32)
        (param $tab_width i32) (result i32)
    (local $slash i32) (local $i i32) (local $ch i32) (local $tail i32)
    (local $keep i32) (local $measured i32) (local $prefix i32)
    (local.set $prefix (call $gdi_bitmap_text_prefix_address
      (local.get $text) (i32.const 0)))
    (local.set $measured (call $gdi_bitmap_text_layout_measure
      (local.get $hdc) (local.get $text) (local.get $count)
      (i32.const 1) (local.get $tab_width)))
    (if (i32.le_s (local.get $measured) (local.get $max_width))
      (then (return (local.get $count))))
    (if (i32.ne (i32.and (local.get $format) (i32.const 0x4000)) (i32.const 0))
      (then
        (local.set $slash (i32.const -1))
        (local.set $i (i32.const 0))
        (block $slashes_done (loop $slashes
          (br_if $slashes_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $ch (i32.and (i32.load16_u (i32.add (local.get $text)
            (i32.shl (local.get $i) (i32.const 1)))) (i32.const 0xFF)))
          (if (i32.or (i32.eq (local.get $ch) (i32.const 47))
                (i32.eq (local.get $ch) (i32.const 92)))
            (then (local.set $slash (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $slashes)))
        (if (i32.lt_s (local.get $slash) (i32.const 0))
          (then (local.set $slash (local.get $count))))
        (local.set $tail (i32.sub (local.get $count) (local.get $slash)))
        (memory.copy
          (i32.add (local.get $text)
            (i32.shl (i32.add (local.get $slash) (i32.const 3)) (i32.const 1)))
          (i32.add (local.get $text) (i32.shl (local.get $slash) (i32.const 1)))
          (i32.shl (local.get $tail) (i32.const 1)))
        (if (local.get $prefix)
          (then
            (memory.copy
              (i32.add (local.get $prefix) (i32.add (local.get $slash) (i32.const 3)))
              (i32.add (local.get $prefix) (local.get $slash))
              (local.get $tail))
            (i32.store8 (i32.add (local.get $prefix) (local.get $slash)) (i32.const 0))
            (i32.store8 (i32.add (local.get $prefix)
              (i32.add (local.get $slash) (i32.const 1))) (i32.const 0))
            (i32.store8 (i32.add (local.get $prefix)
              (i32.add (local.get $slash) (i32.const 2))) (i32.const 0))))
        (i32.store16 (i32.add (local.get $text)
          (i32.shl (local.get $slash) (i32.const 1))) (i32.const 46))
        (i32.store16 (i32.add (local.get $text)
          (i32.shl (i32.add (local.get $slash) (i32.const 1)) (i32.const 1))) (i32.const 46))
        (i32.store16 (i32.add (local.get $text)
          (i32.shl (i32.add (local.get $slash) (i32.const 2)) (i32.const 1))) (i32.const 46))
        (local.set $count (i32.add (local.get $count) (i32.const 3)))
        (block $path_done (loop $path_shrink
          (br_if $path_done (i32.eqz (local.get $slash)))
          (br_if $path_done (i32.le_s
            (call $gdi_bitmap_text_layout_measure (local.get $hdc)
              (local.get $text) (local.get $count) (i32.const 1) (local.get $tab_width))
            (local.get $max_width)))
          (memory.copy
            (i32.add (local.get $text)
              (i32.shl (i32.sub (local.get $slash) (i32.const 1)) (i32.const 1)))
            (i32.add (local.get $text) (i32.shl (local.get $slash) (i32.const 1)))
            (i32.shl (i32.sub (local.get $count) (local.get $slash)) (i32.const 1)))
          (if (local.get $prefix)
            (then (memory.copy
              (i32.add (local.get $prefix) (i32.sub (local.get $slash) (i32.const 1)))
              (i32.add (local.get $prefix) (local.get $slash))
              (i32.sub (local.get $count) (local.get $slash)))))
          (local.set $slash (i32.sub (local.get $slash) (i32.const 1)))
          (local.set $count (i32.sub (local.get $count) (i32.const 1)))
          (br $path_shrink)))))
    (local.set $measured (call $gdi_bitmap_text_layout_measure
      (local.get $hdc) (local.get $text) (local.get $count)
      (i32.const 1) (local.get $tab_width)))
    (if (i32.and (i32.gt_s (local.get $measured) (local.get $max_width))
          (i32.ne (i32.and (local.get $format) (i32.const 0x48000)) (i32.const 0)))
      (then
        (local.set $keep (local.get $count))
        (block $fit_done (loop $fit
          (i32.store16 (i32.add (local.get $text)
            (i32.shl (local.get $keep) (i32.const 1))) (i32.const 46))
          (i32.store16 (i32.add (local.get $text)
            (i32.shl (i32.add (local.get $keep) (i32.const 1)) (i32.const 1))) (i32.const 46))
          (i32.store16 (i32.add (local.get $text)
            (i32.shl (i32.add (local.get $keep) (i32.const 2)) (i32.const 1))) (i32.const 46))
          (if (local.get $prefix)
            (then
              (i32.store8 (i32.add (local.get $prefix) (local.get $keep)) (i32.const 0))
              (i32.store8 (i32.add (local.get $prefix)
                (i32.add (local.get $keep) (i32.const 1))) (i32.const 0))
              (i32.store8 (i32.add (local.get $prefix)
                (i32.add (local.get $keep) (i32.const 2))) (i32.const 0))))
          (br_if $fit_done (i32.eqz (local.get $keep)))
          (br_if $fit_done (i32.le_s
            (call $gdi_bitmap_text_layout_measure (local.get $hdc)
              (local.get $text) (i32.add (local.get $keep) (i32.const 3))
              (i32.const 1) (local.get $tab_width))
            (local.get $max_width)))
          (local.set $keep (i32.sub (local.get $keep) (i32.const 1)))
          (br $fit)))
        (local.set $count (i32.add (local.get $keep) (i32.const 3)))))
    (i32.store16 (i32.add (local.get $text)
      (i32.shl (local.get $count) (i32.const 1))) (i32.const 0))
    (if (local.get $prefix)
      (then (i32.store8 (i32.add (local.get $prefix) (local.get $count)) (i32.const 0))))
    (local.get $count))

  (func $gdi_bitmap_text_copy_modified (param $destination i32) (param $text i32)
        (param $count i32) (param $wide i32)
    (local $i i32) (local $ch i32)
    (if (i32.eqz (local.get $destination)) (then (return)))
    (block $done (loop $copy
      (br_if $done (i32.gt_u (local.get $i) (local.get $count)))
      (local.set $ch (i32.load16_u (i32.add (local.get $text)
        (i32.shl (local.get $i) (i32.const 1)))))
      (if (local.get $wide)
        (then (i32.store16 (i32.add (local.get $destination)
          (i32.shl (local.get $i) (i32.const 1))) (local.get $ch)))
        (else (i32.store8 (i32.add (local.get $destination) (local.get $i))
          (local.get $ch))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $copy))))

  ;; Return the current line end in the low word and the following line start
  ;; in the high word. Explicit CR/LF boundaries always win; DT_WORDBREAK uses
  ;; the last space that fits and falls back to a character boundary.
  (func $gdi_bitmap_draw_line (param $hdc i32) (param $text i32)
        (param $start i32) (param $count i32) (param $wide i32)
        (param $max_width i32) (param $word_break i32) (param $single_line i32)
        (param $tab_width i32)
        (result i64)
    (local $i i32) (local $ch i32) (local $width i32) (local $last_space i32)
    (local $end i32) (local $next i32)
    (if (local.get $single_line)
      (then
        (return (i64.or (i64.extend_i32_u (local.get $count))
          (i64.shl (i64.extend_i32_u (local.get $count)) (i64.const 32))))))
    (local.set $i (local.get $start))
    (local.set $last_space (i32.const -1))
    (block $done (loop $scan
      (if (i32.ge_u (local.get $i) (local.get $count))
        (then
          (local.set $end (local.get $count))
          (local.set $next (local.get $count))
          (br $done)))
      (local.set $ch (call $gdi_bitmap_text_character
        (local.get $text) (local.get $i) (local.get $wide)))
      (if (i32.or (i32.eq (local.get $ch) (i32.const 10))
            (i32.eq (local.get $ch) (i32.const 13)))
        (then
          (local.set $end (local.get $i))
          (local.set $next (i32.add (local.get $i) (i32.const 1)))
          (if (i32.and (i32.eq (local.get $ch) (i32.const 13))
                (i32.lt_u (local.get $next) (local.get $count)))
            (then
              (if (i32.eq (call $gdi_bitmap_text_character
                    (local.get $text) (local.get $next) (local.get $wide)) (i32.const 10))
                (then (local.set $next (i32.add (local.get $next) (i32.const 1)))))))
          (br $done)))
      (if (i32.or (i32.eq (local.get $ch) (i32.const 32))
            (i32.and (i32.ne (local.get $tab_width) (i32.const 0))
              (i32.eq (local.get $ch) (i32.const 9))))
        (then (local.set $last_space (local.get $i))))
      (if (i32.and (i32.ne (local.get $tab_width) (i32.const 0))
            (i32.eq (local.get $ch) (i32.const 9)))
        (then (local.set $width (call $gdi_bitmap_text_next_tab
          (local.get $width) (i32.const 0) (local.get $tab_width))))
        (else (local.set $width (i32.add (local.get $width)
          (call $gdi_font_character_width
            (local.get $hdc) (local.get $ch) (local.get $wide))))))
      (if (i32.and (local.get $word_break)
            (i32.and (i32.gt_s (local.get $width) (local.get $max_width))
              (i32.gt_u (local.get $i) (local.get $start))))
        (then
          (if (i32.ge_s (local.get $last_space) (local.get $start))
            (then
              (local.set $end (local.get $last_space))
              (local.set $next (i32.add (local.get $last_space) (i32.const 1)))
              (block $spaces_done (loop $spaces
                (br_if $spaces_done (i32.ge_u (local.get $next) (local.get $count)))
                (br_if $spaces_done (i32.ne (call $gdi_bitmap_text_character
                  (local.get $text) (local.get $next) (local.get $wide)) (i32.const 32)))
                (local.set $next (i32.add (local.get $next) (i32.const 1)))
                (br $spaces))))
            (else
              (local.set $end (local.get $i))
              (local.set $next (local.get $i))))
          (br $done)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i64.or (i64.extend_i32_u (local.get $end))
      (i64.shl (i64.extend_i32_u (local.get $next)) (i64.const 32))))

  ;; Emit one already-laid-out scalable DrawText line into an open WAT path.
  ;; Canvas supplies only masks for non-tab runs. WAT owns alignment, tabs,
  ;; mnemonic underlines, UTF-16 preservation, and retained geometry.
  (func $gdi_scalable_draw_text_line (param $hdc i32) (param $x i32)
        (param $y i32) (param $text i32) (param $count i32)
        (param $wide i32) (param $tab_width i32) (param $line_width i32)
        (param $options i32) (param $rect i32)
        (result i32)
    (local $desc i32) (local $align i32) (local $temporary_align i32)
    (local $anchor i32) (local $start i32) (local $cursor i32)
    (local $i i32) (local $run_start i32) (local $run_count i32)
    (local $run_width i32) (local $ch i32) (local $j i32)
    (local $prefix_width i32) (local $char_width i32)
    (local $metrics i32) (local $height i32) (local $top i32)
    (local $entry i32) (local $origin_x i32) (local $origin_y i32)
    (local $path_open i32) (local $clip i32) (local $clip_left i32)
    (local $clip_top i32) (local $clip_right i32) (local $clip_bottom i32)
    (local $tmp i32) (local $text_color i32) (local $bk_color i32)
    (local $pixel i32)
    (local.set $desc (global.get $GDI_BITMAP_FONT_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $path_open (call $gdi_dc_path_is_open (local.get $hdc)))
    (if (local.get $path_open)
      (then
        (local.set $entry (call $gdi_dc_path_entry (local.get $hdc) (i32.const 0)))
        (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))))
    (local.set $align (call $gdi_dc_get_field
      (local.get $hdc) (i32.const 32) (i32.const 0)))
    (local.set $anchor (call $gdi_line_map_x (local.get $desc) (local.get $x)))
    (local.set $start (local.get $anchor))
    (if (i32.eq (i32.and (local.get $align) (i32.const 6)) (i32.const 2))
      (then (local.set $start (i32.sub (local.get $start) (local.get $line_width)))))
    (if (i32.eq (i32.and (local.get $align) (i32.const 6)) (i32.const 6))
      (then (local.set $start (i32.sub
        (local.get $start) (i32.shr_u (local.get $line_width) (i32.const 1))))))
    (local.set $metrics (call $host_get_text_metrics (local.get $hdc)))
    (local.set $height (i32.and (local.get $metrics) (i32.const 0xFFFF)))
    (if (i32.eqz (local.get $height)) (then (local.set $height (i32.const 13))))
    (local.set $top (call $gdi_line_map_y (local.get $desc) (local.get $y)))
    (if (i32.eq (i32.and (local.get $align) (i32.const 24)) (i32.const 8))
      (then (local.set $top (i32.sub (local.get $top) (local.get $height)))))
    (if (i32.eq (i32.and (local.get $align) (i32.const 24)) (i32.const 24))
      (then (local.set $top (i32.sub (local.get $top)
        (i32.div_u (i32.add (i32.mul (local.get $height) (i32.const 4))
          (i32.const 2)) (i32.const 5))))))
    (local.set $origin_x (i32.load offset=72 (local.get $desc)))
    (local.set $origin_y (i32.load offset=76 (local.get $desc)))
    (local.set $clip (i32.ne
      (i32.and (local.get $options) (i32.const 4)) (i32.const 0)))
    (if (i32.and (local.get $clip) (i32.ne (local.get $rect) (i32.const 0)))
      (then
        (local.set $clip_left (call $gdi_line_map_x
          (local.get $desc) (i32.load (local.get $rect))))
        (local.set $clip_top (call $gdi_line_map_y
          (local.get $desc) (i32.load offset=4 (local.get $rect))))
        (local.set $clip_right (call $gdi_line_map_x
          (local.get $desc) (i32.load offset=8 (local.get $rect))))
        (local.set $clip_bottom (call $gdi_line_map_y
          (local.get $desc) (i32.load offset=12 (local.get $rect))))
        (if (i32.gt_s (local.get $clip_left) (local.get $clip_right))
          (then
            (local.set $tmp (local.get $clip_left))
            (local.set $clip_left (local.get $clip_right))
            (local.set $clip_right (local.get $tmp))))
        (if (i32.gt_s (local.get $clip_top) (local.get $clip_bottom))
          (then
            (local.set $tmp (local.get $clip_top))
            (local.set $clip_top (local.get $clip_bottom))
            (local.set $clip_bottom (local.get $tmp))))))
    (if (i32.eqz (local.get $path_open))
      (then
        (local.set $text_color (call $gdi_raster_swap_rb
          (call $gdi_dc_get_field (local.get $hdc) (i32.const 20) (i32.const 0))))
        (local.set $bk_color (call $gdi_raster_swap_rb
          (call $gdi_dc_get_field
            (local.get $hdc) (i32.const 24) (i32.const 0xFFFFFF))))
        (if (i32.eq (call $gdi_dc_get_field
              (local.get $hdc) (i32.const 28) (i32.const 2)) (i32.const 2))
          (then (call $gdi_bitmap_text_fill
            (local.get $hdc) (local.get $desc)
            (local.get $start) (local.get $top)
            (i32.add (local.get $start) (local.get $line_width))
            (i32.add (local.get $top) (local.get $height))
            (local.get $bk_color) (local.get $clip)
            (local.get $clip_left) (local.get $clip_top)
            (local.get $clip_right) (local.get $clip_bottom))))))
    (local.set $temporary_align (i32.and (local.get $align) (i32.const 24)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
      (local.get $temporary_align) (i32.const 0)))
    (local.set $cursor (local.get $start))
    (block $done (loop $runs
      (local.set $run_start (local.get $i))
      (block $run_done (loop $scan
        (br_if $run_done (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $ch (call $gdi_bitmap_text_character
          (local.get $text) (local.get $i) (local.get $wide)))
        (br_if $run_done (i32.and
          (i32.ne (local.get $tab_width) (i32.const 0))
          (i32.eq (local.get $ch) (i32.const 9))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
      (local.set $run_count (i32.sub (local.get $i) (local.get $run_start)))
      (if (i32.gt_u (local.get $run_count) (i32.const 0))
        (then
          (if (i32.eqz (call $host_gdi_ext_text_out
                (local.get $hdc)
                (call $gdi_shape_unmap_x (local.get $desc) (local.get $cursor))
                (local.get $y) (local.get $options) (local.get $rect)
                (i32.add (local.get $text)
                  (select (i32.shl (local.get $run_start) (i32.const 1))
                    (local.get $run_start) (local.get $wide)))
                (local.get $run_count) (i32.const 0) (local.get $wide)))
            (then
              (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
                (local.get $align) (i32.const 0)))
              (return (i32.const 0))))
          (local.set $run_width (call $gdi_bitmap_text_layout_measure
            (local.get $hdc)
            (i32.add (local.get $text)
              (select (i32.shl (local.get $run_start) (i32.const 1))
                (local.get $run_start) (local.get $wide)))
            (local.get $run_count) (local.get $wide) (i32.const 0)))
          (local.set $j (local.get $run_start))
          (block $prefixes_done (loop $prefixes
            (br_if $prefixes_done (i32.ge_u (local.get $j) (local.get $i)))
            (if (call $gdi_bitmap_text_is_prefix (local.get $text) (local.get $j))
              (then
                (local.set $prefix_width (call $gdi_bitmap_text_layout_measure
                  (local.get $hdc)
                  (i32.add (local.get $text)
                    (select (i32.shl (local.get $run_start) (i32.const 1))
                      (local.get $run_start) (local.get $wide)))
                  (i32.sub (local.get $j) (local.get $run_start))
                  (local.get $wide) (i32.const 0)))
                (local.set $char_width (call $gdi_font_character_width
                  (local.get $hdc)
                  (call $gdi_bitmap_text_character
                    (local.get $text) (local.get $j) (local.get $wide))
                  (local.get $wide)))
                (if (local.get $path_open)
                  (then (drop (call $gdi_dc_path_append_device_rect (local.get $entry)
                    (i32.sub (i32.add (local.get $cursor) (local.get $prefix_width))
                      (local.get $origin_x))
                    (i32.sub (i32.sub (i32.add (local.get $top) (local.get $height))
                      (i32.const 1)) (local.get $origin_y))
                    (i32.sub (i32.add
                      (i32.add (local.get $cursor) (local.get $prefix_width))
                      (local.get $char_width)) (local.get $origin_x))
                    (i32.sub (i32.add (local.get $top) (local.get $height))
                      (local.get $origin_y)))))
                  (else
                    (local.set $pixel (i32.const 0))
                    (block $underline_done (loop $underline_pixels
                      (br_if $underline_done
                        (i32.ge_u (local.get $pixel) (local.get $char_width)))
                      (drop (call $gdi_bitmap_text_pixel_rect
                        (local.get $hdc) (local.get $desc)
                        (i32.add (i32.add (local.get $cursor) (local.get $prefix_width))
                          (local.get $pixel))
                        (i32.sub (i32.add (local.get $top) (local.get $height))
                          (i32.const 1))
                        (local.get $text_color) (local.get $clip)
                        (local.get $clip_left) (local.get $clip_top)
                        (local.get $clip_right) (local.get $clip_bottom)))
                      (local.set $pixel (i32.add (local.get $pixel) (i32.const 1)))
                      (br $underline_pixels)))
                    ))))
            (local.set $j (i32.add (local.get $j) (i32.const 1)))
            (br $prefixes)))
          (local.set $cursor (i32.add (local.get $cursor) (local.get $run_width)))))
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $cursor (i32.add (local.get $start)
        (call $gdi_bitmap_text_next_tab
          (i32.sub (local.get $cursor) (local.get $start))
          (i32.const 0) (local.get $tab_width))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $runs)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
      (local.get $align) (i32.const 0)))
    (if (i32.eqz (local.get $path_open))
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $start) (local.get $top)
        (i32.add (local.get $start) (local.get $line_width))
        (i32.add (local.get $top) (local.get $height)))))
    (i32.const 1))

  (func $gdi_bitmap_text_out (param $hdc i32) (param $x i32) (param $y i32)
        (param $options i32) (param $rect i32) (param $text i32) (param $count i32)
        (param $dx_array i32) (param $wide i32) (result i32)
    (local $strike i32) (local $height i32) (local $native_height i32)
    (local $desc i32) (local $align i32) (local $width i32) (local $cursor i32) (local $top i32)
    (local $line_origin i32) (local $raw_code i32) (local $is_tab i32)
    (local $i i32) (local $code i32) (local $glyph i32) (local $glyph_width i32)
    (local $glyph_offset i32) (local $sx i32) (local $sy i32) (local $dx i32) (local $dy i32)
    (local $bit i32) (local $text_color i32) (local $bk_color i32)
    (local $char_extra i32) (local $justify_extra i32) (local $justify_count i32) (local $add i32)
    (local $left i32) (local $right i32) (local $bottom i32)
    (local $clip i32) (local $clip_left i32) (local $clip_top i32)
    (local $clip_right i32) (local $clip_bottom i32) (local $tmp i32)
    (local $advance i32) (local $advance_y i32) (local $pdy i32)
    (local $update_x i32) (local $update_y i32)
    (local $dirty_left i32) (local $dirty_top i32)
    (local $dirty_right i32) (local $dirty_bottom i32)
    (local $path_open i32) (local $path_entry i32) (local $path_points i64)
    (local $path_origin_x i32) (local $path_origin_y i32)
    (local.set $strike (call $gdi_bitmap_font_selected (local.get $hdc)))
    (if (i32.eqz (local.get $strike)) (then (return (i32.const -1))))
    (if (i32.or (i32.lt_s (local.get $count) (i32.const 0))
          (i32.or (i32.gt_u (local.get $count) (i32.const 65536))
            (i32.and (i32.gt_s (local.get $count) (i32.const 0))
              (i32.eqz (local.get $text)))))
      (then (return (i32.const 0))))
    (local.set $desc (global.get $GDI_BITMAP_FONT_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (local.set $clip (i32.ne
      (i32.and (local.get $options) (i32.const 4)) (i32.const 0)))
    (if (i32.and (i32.ne (i32.and (local.get $options) (i32.const 6)) (i32.const 0))
          (i32.eqz (local.get $rect)))
      (then (return (i32.const 0))))
    (if (local.get $rect)
      (then
        (local.set $clip_left (call $gdi_line_map_x
          (local.get $desc) (i32.load (local.get $rect))))
        (local.set $clip_top (call $gdi_line_map_y
          (local.get $desc) (i32.load offset=4 (local.get $rect))))
        (local.set $clip_right (call $gdi_line_map_x
          (local.get $desc) (i32.load offset=8 (local.get $rect))))
        (local.set $clip_bottom (call $gdi_line_map_y
          (local.get $desc) (i32.load offset=12 (local.get $rect))))
        (if (i32.gt_s (local.get $clip_left) (local.get $clip_right))
          (then
            (local.set $tmp (local.get $clip_left))
            (local.set $clip_left (local.get $clip_right))
            (local.set $clip_right (local.get $tmp))))
        (if (i32.gt_s (local.get $clip_top) (local.get $clip_bottom))
          (then
            (local.set $tmp (local.get $clip_top))
            (local.set $clip_top (local.get $clip_bottom))
            (local.set $clip_bottom (local.get $tmp))))))
    (local.set $height (call $gdi_bitmap_font_height (local.get $hdc) (local.get $strike)))
    (local.set $native_height (i32.load offset=20 (local.get $strike)))
    (local.set $width (call $gdi_bitmap_text_layout_measure
      (local.get $hdc) (local.get $text) (local.get $count) (local.get $wide)
      (global.get $gdi_bitmap_text_active_tab_width)))
    (local.set $char_extra (call $gdi_dc_aux_get (local.get $hdc) (i32.const 20) (i32.const 0)))
    (local.set $justify_extra (call $gdi_dc_aux_get (local.get $hdc) (i32.const 24) (i32.const 0)))
    (local.set $justify_count (call $gdi_dc_aux_get (local.get $hdc) (i32.const 28) (i32.const 0)))
    (local.set $pdy (i32.ne
      (i32.and (local.get $options) (i32.const 0x2000)) (i32.const 0)))
    (if (local.get $dx_array)
      (then
        (local.set $width (i32.const 0))
        (local.set $i (i32.const 0))
        (block $dx_done (loop $dx_widths
          (br_if $dx_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $width (i32.add (local.get $width)
            (call $gdi_bitmap_text_scale_x_delta (local.get $desc)
              (i32.load (i32.add (local.get $dx_array)
                (i32.mul (local.get $i) (select (i32.const 8) (i32.const 4)
                  (local.get $pdy))))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $dx_widths))))
      (else
        (if (i32.gt_s (local.get $count) (i32.const 1))
          (then (local.set $width (i32.add (local.get $width)
            (i32.mul (i32.sub (local.get $count) (i32.const 1)) (local.get $char_extra))))))
        (if (i32.gt_s (local.get $justify_count) (i32.const 0))
          (then (local.set $width (i32.add (local.get $width) (local.get $justify_extra)))))))
    (local.set $align (call $gdi_dc_get_field (local.get $hdc) (i32.const 32) (i32.const 0)))
    (if (i32.ne (i32.and (local.get $align) (i32.const 1)) (i32.const 0))
      (then
        (local.set $x (call $gdi_dc_get_field (local.get $hdc) (i32.const 12) (i32.const 0)))
        (local.set $y (call $gdi_dc_get_field (local.get $hdc) (i32.const 16) (i32.const 0)))))
    (local.set $update_x (local.get $x))
    (local.set $update_y (local.get $y))
    (local.set $i (i32.const 0))
    (local.set $cursor (call $gdi_line_map_x (local.get $desc) (local.get $x)))
    (local.set $top (call $gdi_line_map_y (local.get $desc) (local.get $y)))
    (if (i32.eq (i32.and (local.get $align) (i32.const 6)) (i32.const 2))
      (then (local.set $cursor (i32.sub (local.get $cursor) (local.get $width)))))
    (if (i32.eq (i32.and (local.get $align) (i32.const 6)) (i32.const 6))
      (then (local.set $cursor (i32.sub (local.get $cursor) (i32.shr_s (local.get $width) (i32.const 1))))))
    (if (i32.eq (i32.and (local.get $align) (i32.const 24)) (i32.const 8))
      (then (local.set $top (i32.sub (local.get $top) (local.get $height)))))
    (if (i32.eq (i32.and (local.get $align) (i32.const 24)) (i32.const 24))
      (then (local.set $top (i32.sub (local.get $top) (call $gdi_round_ratio
        (i64.mul (i64.extend_i32_u (i32.load offset=24 (local.get $strike)))
          (i64.extend_i32_u (local.get $height)))
        (i64.extend_i32_u (local.get $native_height)))))))
    (local.set $line_origin (local.get $cursor))
    (local.set $left (local.get $cursor))
    (local.set $right (i32.add (local.get $cursor) (local.get $width)))
    (local.set $bottom (i32.add (local.get $top) (local.get $height)))
    (local.set $text_color (call $gdi_raster_swap_rb
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 20) (i32.const 0))))
    (local.set $bk_color (call $gdi_raster_swap_rb
      (call $gdi_dc_get_field (local.get $hdc) (i32.const 24) (i32.const 0xFFFFFF))))
    (local.set $dirty_left (local.get $left))
    (local.set $dirty_top (local.get $top))
    (local.set $dirty_right (local.get $right))
    (local.set $dirty_bottom (local.get $bottom))
    (local.set $path_open (call $gdi_dc_path_is_open (local.get $hdc)))
    (if (local.get $path_open)
      (then
        (local.set $path_entry (call $gdi_dc_path_entry (local.get $hdc) (i32.const 0)))
        (local.set $path_origin_x (i32.load offset=72 (local.get $desc)))
        (local.set $path_origin_y (i32.load offset=76 (local.get $desc)))
        ;; Reserve a conservative all-pixels upper bound before recording any
        ;; glyph geometry. Real glyphs normally use much less, but this makes
        ;; an allocation/capacity failure atomic with respect to the path.
        (local.set $i (i32.const 0))
        (block $path_count_done (loop $path_count
          (br_if $path_count_done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $raw_code (select
            (i32.load8_u (i32.add (local.get $text) (local.get $i)))
            (i32.load16_u (i32.add (local.get $text) (i32.shl (local.get $i) (i32.const 1))))
            (i32.eqz (local.get $wide))))
          (local.set $code (i32.and (local.get $raw_code) (i32.const 0xFF)))
          (local.set $is_tab (i32.and
            (i32.ne (global.get $gdi_bitmap_text_active_tab_width) (i32.const 0))
            (i32.eq (local.get $code) (i32.const 9))))
          (local.set $glyph (call $gdi_bitmap_font_glyph (local.get $strike) (local.get $code)))
          (local.set $glyph_width (call $gdi_bitmap_font_scaled_width
            (local.get $strike) (local.get $glyph) (local.get $height)))
          (if (i32.eqz (local.get $is_tab))
            (then
              (local.set $path_points (i64.add (local.get $path_points)
                (i64.mul (i64.extend_i32_u (local.get $glyph_width))
                  (i64.mul (i64.extend_i32_u (local.get $height)) (i64.const 4)))))
              (if (call $gdi_bitmap_text_is_prefix
                    (local.get $text) (local.get $i))
                (then (local.set $path_points (i64.add (local.get $path_points)
                  (i64.mul (i64.extend_i32_u (local.get $glyph_width)) (i64.const 4))))))))
          (if (i64.gt_u (local.get $path_points) (i64.const 65536))
            (then (return (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $path_count)))
        (if (i32.eqz (call $gdi_dc_path_reserve
              (local.get $path_entry) (i32.wrap_i64 (local.get $path_points))))
          (then (return (i32.const 0))))
        (local.set $i (i32.const 0))))
    (if (i32.and (i32.eqz (local.get $path_open))
          (i32.ne (i32.and (local.get $options) (i32.const 2)) (i32.const 0)))
      (then
        (call $gdi_bitmap_text_fill (local.get $hdc) (local.get $desc)
          (local.get $clip_left) (local.get $clip_top)
          (local.get $clip_right) (local.get $clip_bottom) (local.get $bk_color)
          (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
        (if (i32.lt_s (local.get $clip_left) (local.get $dirty_left))
          (then (local.set $dirty_left (local.get $clip_left))))
        (if (i32.lt_s (local.get $clip_top) (local.get $dirty_top))
          (then (local.set $dirty_top (local.get $clip_top))))
        (if (i32.gt_s (local.get $clip_right) (local.get $dirty_right))
          (then (local.set $dirty_right (local.get $clip_right))))
        (if (i32.gt_s (local.get $clip_bottom) (local.get $dirty_bottom))
          (then (local.set $dirty_bottom (local.get $clip_bottom))))))
    (if (i32.and (i32.eqz (local.get $path_open))
          (i32.eq (call $gdi_dc_get_field (local.get $hdc) (i32.const 28) (i32.const 2))
            (i32.const 2)))
      (then (call $gdi_bitmap_text_fill (local.get $hdc) (local.get $desc)
        (local.get $left) (local.get $top) (local.get $right) (local.get $bottom)
        (local.get $bk_color) (local.get $clip)
        (local.get $clip_left) (local.get $clip_top)
        (local.get $clip_right) (local.get $clip_bottom))))
    (block $done (loop $characters
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $raw_code (select
        (i32.load8_u (i32.add (local.get $text) (local.get $i)))
        (i32.load16_u (i32.add (local.get $text) (i32.shl (local.get $i) (i32.const 1))))
        (i32.eqz (local.get $wide))))
      (local.set $code (i32.and (local.get $raw_code) (i32.const 0xFF)))
      (local.set $is_tab (i32.and
        (i32.ne (global.get $gdi_bitmap_text_active_tab_width) (i32.const 0))
        (i32.eq (local.get $code) (i32.const 9))))
      (local.set $glyph (call $gdi_bitmap_font_glyph (local.get $strike) (local.get $code)))
      (local.set $glyph_width (call $gdi_bitmap_font_scaled_width
        (local.get $strike) (local.get $glyph) (local.get $height)))
      (if (local.get $is_tab)
        (then (local.set $glyph_width (i32.sub
          (call $gdi_bitmap_text_next_tab (local.get $cursor) (local.get $line_origin)
            (global.get $gdi_bitmap_text_active_tab_width))
          (local.get $cursor)))))
      (local.set $glyph_offset (select (i32.load16_u offset=2 (local.get $glyph))
        (i32.load offset=2 (local.get $glyph))
        (i32.eq (i32.load offset=16 (local.get $strike)) (i32.const 0x0200))))
      (if (i32.lt_s (local.get $cursor) (local.get $dirty_left))
        (then (local.set $dirty_left (local.get $cursor))))
      (if (i32.gt_s (i32.add (local.get $cursor) (local.get $glyph_width))
            (local.get $dirty_right))
        (then (local.set $dirty_right
          (i32.add (local.get $cursor) (local.get $glyph_width)))))
      (if (i32.lt_s (local.get $top) (local.get $dirty_top))
        (then (local.set $dirty_top (local.get $top))))
      (if (i32.gt_s (i32.add (local.get $top) (local.get $height))
            (local.get $dirty_bottom))
        (then (local.set $dirty_bottom (i32.add (local.get $top) (local.get $height)))))
      (local.set $dy (i32.const 0))
      (block $glyph_done (loop $glyph_rows
        (br_if $glyph_done (i32.ge_s (local.get $dy) (local.get $height)))
        (local.set $sy (i32.div_u (i32.mul (local.get $dy) (local.get $native_height)) (local.get $height)))
        (local.set $dx (i32.const 0))
        (block $row_done (loop $glyph_row
          (br_if $row_done (i32.ge_s (local.get $dx) (local.get $glyph_width)))
          (local.set $sx (i32.div_u (i32.mul (local.get $dx) (i32.load16_u (local.get $glyph)))
            (local.get $glyph_width)))
          (local.set $bit (i32.and (i32.load8_u (i32.add
            (i32.add (i32.load offset=8 (local.get $strike)) (local.get $glyph_offset))
            (i32.add (i32.mul (i32.shr_u (local.get $sx) (i32.const 3)) (local.get $native_height))
              (local.get $sy))))
            (i32.shl (i32.const 1) (i32.sub (i32.const 7) (i32.and (local.get $sx) (i32.const 7))))))
          (if (i32.and (i32.ne (local.get $bit) (i32.const 0))
                (i32.eqz (local.get $is_tab)))
            (then
              (if (local.get $path_open)
                (then (drop (call $gdi_dc_path_append_device_rect (local.get $path_entry)
                  (i32.sub (i32.add (local.get $cursor) (local.get $dx))
                    (local.get $path_origin_x))
                  (i32.sub (i32.add (local.get $top) (local.get $dy))
                    (local.get $path_origin_y))
                  (i32.sub (i32.add (i32.add (local.get $cursor) (local.get $dx))
                    (i32.const 1)) (local.get $path_origin_x))
                  (i32.sub (i32.add (i32.add (local.get $top) (local.get $dy))
                    (i32.const 1)) (local.get $path_origin_y)))))
                (else (drop (call $gdi_bitmap_text_pixel_rect
                  (local.get $hdc) (local.get $desc)
                  (i32.add (local.get $cursor) (local.get $dx))
                  (i32.add (local.get $top) (local.get $dy)) (local.get $text_color)
                  (local.get $clip) (local.get $clip_left) (local.get $clip_top)
                  (local.get $clip_right) (local.get $clip_bottom)))))))
          (local.set $dx (i32.add (local.get $dx) (i32.const 1)))
          (br $glyph_row)))
        (local.set $dy (i32.add (local.get $dy) (i32.const 1)))
        (br $glyph_rows)))
      ;; DrawText prefix flags are stored separately from UTF-16 code units.
      ;; Underline the marked glyph on the final cell row.
      (if (i32.and (call $gdi_bitmap_text_is_prefix
              (local.get $text) (local.get $i))
            (i32.eqz (local.get $is_tab)))
        (then
          (local.set $dx (i32.const 0))
          (block $underline_done (loop $underline
            (br_if $underline_done (i32.ge_s (local.get $dx) (local.get $glyph_width)))
            (if (local.get $path_open)
              (then (drop (call $gdi_dc_path_append_device_rect (local.get $path_entry)
                (i32.sub (i32.add (local.get $cursor) (local.get $dx))
                  (local.get $path_origin_x))
                (i32.sub (i32.sub (i32.add (local.get $top) (local.get $height))
                  (i32.const 1)) (local.get $path_origin_y))
                (i32.sub (i32.add (i32.add (local.get $cursor) (local.get $dx))
                  (i32.const 1)) (local.get $path_origin_x))
                (i32.sub (i32.add (local.get $top) (local.get $height))
                  (local.get $path_origin_y)))))
              (else (drop (call $gdi_bitmap_text_pixel_rect
                (local.get $hdc) (local.get $desc)
                (i32.add (local.get $cursor) (local.get $dx))
                (i32.sub (i32.add (local.get $top) (local.get $height)) (i32.const 1))
                (local.get $text_color) (local.get $clip)
                (local.get $clip_left) (local.get $clip_top)
                (local.get $clip_right) (local.get $clip_bottom)))))
            (local.set $dx (i32.add (local.get $dx) (i32.const 1)))
            (br $underline)))))
      (if (local.get $dx_array)
        (then
          (local.set $advance
            (call $gdi_bitmap_text_scale_x_delta
              (local.get $desc)
              (i32.load
                (i32.add
                  (local.get $dx_array)
                  (i32.mul
                    (local.get $i)
                    (select (i32.const 8) (i32.const 4) (local.get $pdy)))))))
          (local.set $cursor (i32.add (local.get $cursor) (local.get $advance)))
          (local.set $update_x
            (i32.add
              (local.get $update_x)
              (i32.load
                (i32.add
                  (local.get $dx_array)
                  (i32.mul
                    (local.get $i)
                    (select (i32.const 8) (i32.const 4) (local.get $pdy)))))))
          (if (local.get $pdy)
            (then
              (local.set $advance_y
                (call $gdi_bitmap_text_scale_y_delta
                  (local.get $desc)
                  (i32.load offset=4
                    (i32.add (local.get $dx_array)
                      (i32.shl (local.get $i) (i32.const 3))))))
              (local.set $top (i32.add (local.get $top) (local.get $advance_y)))
              (local.set $update_y
                (i32.add
                  (local.get $update_y)
                  (i32.load offset=4
                    (i32.add (local.get $dx_array)
                      (i32.shl (local.get $i) (i32.const 3)))))))))
        (else
          (local.set $cursor (i32.add (local.get $cursor) (local.get $glyph_width)))
          (if (i32.lt_u (i32.add (local.get $i) (i32.const 1)) (local.get $count))
            (then (local.set $cursor (i32.add (local.get $cursor) (local.get $char_extra)))))
          (if (i32.and (i32.eq (local.get $code) (i32.const 32))
                (i32.gt_s (local.get $justify_count) (i32.const 0)))
            (then
              (local.set $add (i32.div_s (local.get $justify_extra) (local.get $justify_count)))
              (local.set $cursor (i32.add (local.get $cursor) (local.get $add)))
              (local.set $justify_extra (i32.sub (local.get $justify_extra) (local.get $add)))
              (local.set $justify_count (i32.sub (local.get $justify_count) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $characters)))
    (if (i32.and (i32.ne (i32.and (local.get $align) (i32.const 1)) (i32.const 0))
          (i32.eqz (local.get $dx_array)))
      (then (local.set $update_x (i32.add (local.get $update_x)
        (call $gdi_bitmap_text_device_x_delta (local.get $desc) (local.get $width))))))
    (if (i32.ne (i32.and (local.get $align) (i32.const 1)) (i32.const 0))
      (then
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 12)
          (local.get $update_x) (i32.const 0)))
        (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 16)
          (local.get $update_y) (i32.const 0)))))
    (if (i32.eqz (local.get $path_open))
      (then (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
        (local.get $dirty_left) (local.get $dirty_top)
        (local.get $dirty_right) (local.get $dirty_bottom))))
    (i32.const 1))

  (func $gdi_bitmap_draw_text (param $hdc i32) (param $text i32) (param $count i32)
        (param $rect i32) (param $format i32) (param $wide i32) (result i32)
    (local $strike i32) (local $desc i32) (local $height i32)
    (local $scalable i32) (local $draw_result i32)
    (local $logical_height i32) (local $total_height i32)
    (local $left_device i32) (local $top_device i32) (local $right_device i32)
    (local $bottom_device i32) (local $rect_width i32) (local $device_y i32)
    (local $pos i32) (local $end i32) (local $next i32) (local $line_width i32)
    (local $max_width i32) (local $line_count i32) (local $line i64)
    (local $saved_align i32) (local $draw_align i32) (local $draw_x i32)
    (local $draw_options i32) (local $step i32) (local $ch i32)
    (local $word_break i32) (local $single_line i32)
    (local $original_text i32) (local $original_wide i32)
    (local $prepared i32) (local $tab_width i32) (local $shortened i32)
    (local $visible_lines i32) (local $vertical_ellipsis i32)
    (local.set $strike (call $gdi_bitmap_font_selected (local.get $hdc)))
    (if (i32.eqz (local.get $strike))
      (then (local.set $scalable (i32.const 1))))
    (if (i32.or (i32.eqz (local.get $rect)) (i32.eqz (local.get $text)))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $count) (i32.const -1))
      (then
        (local.set $count (i32.const 0))
        (block $length_done (loop $length
          (br_if $length_done (i32.ge_u (local.get $count) (i32.const 65536)))
          (local.set $ch (call $gdi_bitmap_text_character
            (local.get $text) (local.get $count) (local.get $wide)))
          (br_if $length_done (i32.eqz (local.get $ch)))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (br $length)))))
    (if (i32.or (i32.lt_s (local.get $count) (i32.const 0))
          (i32.gt_u (local.get $count) (i32.const 65536)))
      (then (return (i32.const 0))))
    (local.set $original_text (local.get $text))
    (local.set $original_wide (local.get $wide))
    (local.set $tab_width (call $gdi_bitmap_text_tab_width
      (local.get $hdc) (local.get $strike) (local.get $format)))
    (local.set $format (call $gdi_bitmap_text_consume_tabstop (local.get $format)))
    (local.set $prepared (call $gdi_bitmap_text_prepare_layout
      (local.get $text) (local.get $count) (local.get $wide) (local.get $format)))
    ;; Very large prefix-aware strings retain the complete Canvas DrawText
    ;; fallback instead of being truncated to the private WCHAR buffer.
    (if (i32.lt_s (local.get $prepared) (i32.const 0))
      (then (return (i32.const -1))))
    (local.set $text (global.get $GDI_BITMAP_TEXT_LAYOUT))
    (local.set $count (local.get $prepared))
    (local.set $wide (i32.const 1))
    (local.set $step (i32.const 2))
    (local.set $desc (global.get $GDI_BITMAP_FONT_DESC))
    (if (i32.eqz (call $gdi_surface_descriptor (local.get $hdc) (local.get $desc)))
      (then (return (i32.const 0))))
    (if (local.get $strike)
      (then (local.set $height (call $gdi_bitmap_font_height
        (local.get $hdc) (local.get $strike))))
      (else
        (local.set $height (i32.and
          (call $host_get_text_metrics (local.get $hdc)) (i32.const 0xFFFF)))
        (if (i32.eqz (local.get $height))
          (then (local.set $height (i32.const 13))))))
    (local.set $logical_height (call $gdi_bitmap_text_device_y_delta
      (local.get $desc) (local.get $height)))
    (if (i32.eqz (local.get $logical_height))
      (then (local.set $logical_height (i32.const 1))))
    (local.set $left_device (call $gdi_line_map_x
      (local.get $desc) (i32.load (local.get $rect))))
    (local.set $top_device (call $gdi_line_map_y
      (local.get $desc) (i32.load offset=4 (local.get $rect))))
    (local.set $right_device (call $gdi_line_map_x
      (local.get $desc) (i32.load offset=8 (local.get $rect))))
    (local.set $bottom_device (call $gdi_line_map_y
      (local.get $desc) (i32.load offset=12 (local.get $rect))))
    (if (i32.gt_s (local.get $left_device) (local.get $right_device))
      (then
        (local.set $ch (local.get $left_device))
        (local.set $left_device (local.get $right_device))
        (local.set $right_device (local.get $ch))))
    (if (i32.gt_s (local.get $top_device) (local.get $bottom_device))
      (then
        (local.set $ch (local.get $top_device))
        (local.set $top_device (local.get $bottom_device))
        (local.set $bottom_device (local.get $ch))))
    (local.set $rect_width (i32.sub (local.get $right_device) (local.get $left_device)))
    (local.set $word_break (i32.ne
      (i32.and (local.get $format) (i32.const 0x10)) (i32.const 0)))
    (local.set $single_line (i32.ne
      (i32.and (local.get $format) (i32.const 0x20)) (i32.const 0)))
    (if (i32.gt_s (local.get $height) (i32.const 0))
      (then (local.set $visible_lines (i32.div_s
        (i32.sub (local.get $bottom_device) (local.get $top_device))
        (local.get $height)))))
    (local.set $vertical_ellipsis
      (i32.and
        (i32.and (i32.eqz (local.get $single_line))
          (i32.eqz (i32.and (local.get $format) (i32.const 0x400))))
        (i32.and (i32.gt_s (local.get $visible_lines) (i32.const 0))
          (i32.ne (i32.and (local.get $format) (i32.const 0x4C000)) (i32.const 0)))))
    (if (i32.and (local.get $single_line)
          (i32.ne (i32.and (local.get $format) (i32.const 0x4C000)) (i32.const 0)))
      (then
        (local.set $shortened (call $gdi_bitmap_text_ellipsify
          (local.get $hdc) (local.get $text) (local.get $count)
          (local.get $rect_width) (local.get $format) (local.get $tab_width)))
        (if (i32.ne (local.get $shortened) (local.get $count))
          (then
            (local.set $count (local.get $shortened))
            (if (i32.ne (i32.and (local.get $format) (i32.const 0x10000)) (i32.const 0))
              (then (call $gdi_bitmap_text_copy_modified
                (local.get $original_text) (local.get $text) (local.get $count)
                (local.get $original_wide))))))))
    (if (i32.gt_s (local.get $count) (i32.const 0))
      (then
        (block $layout_done (loop $layout
          (local.set $line (call $gdi_bitmap_draw_line
            (local.get $hdc) (local.get $text) (local.get $pos) (local.get $count)
            (local.get $wide) (local.get $rect_width)
            (local.get $word_break) (local.get $single_line) (local.get $tab_width)))
          (local.set $end (i32.wrap_i64 (local.get $line)))
          (local.set $next (i32.wrap_i64 (i64.shr_u (local.get $line) (i64.const 32))))
          ;; When more wrapped text exists below the rectangle, append an
          ;; ellipsis to the final vertically visible row and discard the
          ;; hidden rows. Feeding the appended dots through the ordinary line
          ;; ellipsifier also shrinks a full-width row enough to fit them.
          (if (i32.and (local.get $vertical_ellipsis)
                (i32.and
                  (i32.eq (i32.add (local.get $line_count) (i32.const 1))
                    (local.get $visible_lines))
                  (i32.lt_u (local.get $next) (local.get $count))))
            (then
              (i32.store16 (i32.add (local.get $text)
                (i32.shl (local.get $end) (i32.const 1))) (i32.const 46))
              (i32.store16 (i32.add (local.get $text)
                (i32.shl (i32.add (local.get $end) (i32.const 1)) (i32.const 1)))
                (i32.const 46))
              (i32.store16 (i32.add (local.get $text)
                (i32.shl (i32.add (local.get $end) (i32.const 2)) (i32.const 1)))
                (i32.const 46))
              (i32.store8 (i32.add (global.get $GDI_BITMAP_TEXT_PREFIX)
                (local.get $end)) (i32.const 0))
              (i32.store8 (i32.add (global.get $GDI_BITMAP_TEXT_PREFIX)
                (i32.add (local.get $end) (i32.const 1))) (i32.const 0))
              (i32.store8 (i32.add (global.get $GDI_BITMAP_TEXT_PREFIX)
                (i32.add (local.get $end) (i32.const 2))) (i32.const 0))
              (local.set $shortened (call $gdi_bitmap_text_ellipsify
                (local.get $hdc)
                (i32.add (local.get $text) (i32.shl (local.get $pos) (i32.const 1)))
                (i32.add (i32.sub (local.get $end) (local.get $pos)) (i32.const 3))
                (local.get $rect_width) (local.get $format) (local.get $tab_width)))
              (local.set $count (i32.add (local.get $pos) (local.get $shortened)))
              (local.set $end (local.get $count))
              (local.set $next (local.get $count))
              (if (i32.ne (i32.and (local.get $format) (i32.const 0x10000)) (i32.const 0))
                (then (call $gdi_bitmap_text_copy_modified
                  (local.get $original_text) (local.get $text) (local.get $count)
                  (local.get $original_wide))))))
          (local.set $line_width (call $gdi_bitmap_text_layout_measure
            (local.get $hdc) (i32.add (local.get $text) (i32.mul (local.get $pos) (local.get $step)))
            (i32.sub (local.get $end) (local.get $pos)) (local.get $wide)
            (local.get $tab_width)))
          (if (i32.gt_s (local.get $line_width) (local.get $max_width))
            (then (local.set $max_width (local.get $line_width))))
          (local.set $line_count (i32.add (local.get $line_count) (i32.const 1)))
          (local.set $pos (local.get $next))
          (br_if $layout_done (i32.ge_u (local.get $pos) (local.get $count)))
          (br $layout)))))
    (local.set $total_height (i32.mul (local.get $line_count) (local.get $logical_height)))
    (if (i32.and (local.get $format) (i32.const 0x400))
      (then
        (i32.store offset=8 (local.get $rect) (i32.add (i32.load (local.get $rect))
          (call $gdi_bitmap_text_device_x_delta (local.get $desc) (local.get $max_width))))
        (i32.store offset=12 (local.get $rect) (i32.add (i32.load offset=4 (local.get $rect))
          (local.get $total_height)))
        (return (local.get $total_height))))
    (if (i32.eqz (local.get $line_count)) (then (return (i32.const 0))))
    (local.set $saved_align (call $gdi_dc_get_field
      (local.get $hdc) (i32.const 32) (i32.const 0)))
    (local.set $draw_align (i32.const 0))
    (local.set $draw_x (i32.load (local.get $rect)))
    (if (i32.and (local.get $format) (i32.const 2))
      (then
        (local.set $draw_align (i32.const 2))
        (local.set $draw_x (i32.load offset=8 (local.get $rect))))
      (else
        (if (i32.and (local.get $format) (i32.const 1))
          (then
            (local.set $draw_align (i32.const 6))
            (local.set $draw_x (i32.shr_s (i32.add
              (i32.load (local.get $rect)) (i32.load offset=8 (local.get $rect)))
              (i32.const 1)))))))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
      (local.get $draw_align) (i32.const 0)))
    (local.set $device_y (local.get $top_device))
    (if (i32.and (local.get $format) (i32.const 8))
      (then (local.set $device_y (i32.sub (local.get $bottom_device)
        (i32.mul (local.get $line_count) (local.get $height)))))
      (else
        (if (i32.and (local.get $format) (i32.const 4))
          (then (local.set $device_y (i32.add (local.get $top_device)
            (i32.shr_s (i32.sub (i32.sub (local.get $bottom_device) (local.get $top_device))
              (i32.mul (local.get $line_count) (local.get $height))) (i32.const 1))))))))
    (local.set $draw_options (select (i32.const 0) (i32.const 4)
      (i32.and (local.get $format) (i32.const 0x100))))
    (local.set $pos (i32.const 0))
    (block $draw_done (loop $draw_lines
      (local.set $line (call $gdi_bitmap_draw_line
        (local.get $hdc) (local.get $text) (local.get $pos) (local.get $count)
        (local.get $wide) (local.get $rect_width)
        (local.get $word_break) (local.get $single_line) (local.get $tab_width)))
      (local.set $end (i32.wrap_i64 (local.get $line)))
      (local.set $next (i32.wrap_i64 (i64.shr_u (local.get $line) (i64.const 32))))
      (local.set $line_width (call $gdi_bitmap_text_layout_measure
        (local.get $hdc)
        (i32.add (local.get $text) (i32.mul (local.get $pos) (local.get $step)))
        (i32.sub (local.get $end) (local.get $pos)) (local.get $wide)
        (local.get $tab_width)))
      (if (local.get $scalable)
        (then (local.set $draw_result (call $gdi_scalable_draw_text_line
          (local.get $hdc) (local.get $draw_x)
          (call $gdi_bitmap_text_unmap_y (local.get $desc) (local.get $device_y))
          (i32.add (local.get $text) (i32.mul (local.get $pos) (local.get $step)))
          (i32.sub (local.get $end) (local.get $pos)) (local.get $wide)
          (local.get $tab_width) (local.get $line_width)
          (local.get $draw_options) (local.get $rect))))
        (else
          (global.set $gdi_bitmap_text_active_tab_width (local.get $tab_width))
          (local.set $draw_result (call $gdi_bitmap_text_out
            (local.get $hdc) (local.get $draw_x)
            (call $gdi_bitmap_text_unmap_y (local.get $desc) (local.get $device_y))
            (local.get $draw_options) (local.get $rect)
            (i32.add (local.get $text) (i32.mul (local.get $pos) (local.get $step)))
            (i32.sub (local.get $end) (local.get $pos))
            (i32.const 0) (local.get $wide)))
          (global.set $gdi_bitmap_text_active_tab_width (i32.const 0))))
      (if (i32.eqz (local.get $draw_result))
        (then
          (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
            (local.get $saved_align) (i32.const 0)))
          (return (i32.const 0))))
      (local.set $device_y (i32.add (local.get $device_y) (local.get $height)))
      (local.set $pos (local.get $next))
      (br_if $draw_done (i32.ge_u (local.get $pos) (local.get $count)))
      (br $draw_lines)))
    (drop (call $gdi_dc_set_field (local.get $hdc) (i32.const 32)
      (local.get $saved_align) (i32.const 0)))
    (local.get $total_height))

  (func (export "test_gdi_bitmap_font_count") (result i32)
    (local $i i32) (local $count i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $GDI_BITMAP_FONT_COUNT)))
      (if (i32.load (call $gdi_bitmap_font_record (local.get $i)))
        (then (local.set $count (i32.add (local.get $count) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $count))
  (func (export "test_gdi_bitmap_font_bound") (param $handle i32) (result i32)
    (local $object i32)
    (local.set $object (call $gdi_object_record (local.get $handle)))
    (if (result i32) (local.get $object)
      (then (i32.load offset=24 (local.get $object))) (else (i32.const 0))))
  (func (export "test_gdi_bitmap_font_selected") (param $hdc i32) (result i32)
    (call $gdi_bitmap_font_selected (local.get $hdc)))
  (func (export "test_gdi_bitmap_font_enum_next")
        (param $after i32) (param $filter i32) (param $wide i32) (result i32)
    (call $gdi_bitmap_font_enum_next (local.get $after) (local.get $filter)
      (local.get $wide)))
  (func (export "test_gdi_bitmap_font_enum_face") (param $candidate i32) (result i32)
    (call $gdi_bitmap_font_enum_face (local.get $candidate)))
  (func (export "test_gdi_bitmap_font_enum_type") (param $candidate i32) (result i32)
    (call $gdi_bitmap_font_enum_type (local.get $candidate)))
  (func (export "test_gdi_bitmap_font_enum_fill")
        (param $candidate i32) (param $lf i32) (param $tm i32)
        (param $wide i32) (result i32)
    (call $gdi_bitmap_font_enum_fill (local.get $candidate) (local.get $lf)
      (local.get $tm) (local.get $wide)))
