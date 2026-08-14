  ;; ---- Win16/Win9x bitmap fonts ---------------------------------------
  ;; Installed FNT strikes are parsed and rasterized entirely in WAT. The
  ;; host boundary is used only to read the virtual file and present dirty
  ;; canonical GDI pixels. Registry record (64 bytes): active/path hash,
  ;; owned FNT WA/size, version, height/ascent/average/max width,
  ;; first/last/default char, weight/charset, face offset, leading values.
  (global $GDI_BITMAP_FONT_TABLE i32 (i32.const 0x07F0A800))
  (global $GDI_BITMAP_FONT_TABLE_SIZE i32 (i32.const 0x00000400))
  (global $GDI_BITMAP_FONT_COUNT i32 (i32.const 16))
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

  (func $gdi_bitmap_font_record (param $index i32) (result i32)
    (i32.add (global.get $GDI_BITMAP_FONT_TABLE)
      (i32.mul (local.get $index) (global.get $GDI_BITMAP_FONT_STRIDE))))

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
      (if (i32.and (i32.load (local.get $strike))
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
          (then (return (local.get $strike))))))
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
    (i32.const 0))

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
      (then (i32.and (i32.load16_u (i32.add (local.get $text)
        (i32.shl (local.get $index) (i32.const 1)))) (i32.const 0xFF)))
      (else (i32.load8_u (i32.add (local.get $text) (local.get $index))))))

  ;; DrawText uses a private WCHAR presentation buffer. Mnemonic prefixes are
  ;; removed, && becomes literal &, and bit 8 marks accelerator underlines.
  ;; Four spare WCHARs accommodate the three-dot ellipsis and terminator.
  (global $GDI_BITMAP_TEXT_LAYOUT i32 (i32.const 0x07F0AC00))
  (global $GDI_BITMAP_TEXT_LAYOUT_CHARS i32 (i32.const 4096))
  (global $gdi_bitmap_text_active_tab_width (mut i32) (i32.const 0))
  (global $gdi_bitmap_draw_text_tab_chars (mut i32) (i32.const 0))

  (func $gdi_bitmap_text_scale_y_delta (param $desc i32) (param $delta i32)
        (result i32)
    (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_s (local.get $delta))
        (i64.extend_i32_s (i32.load offset=60 (local.get $desc))))
      (i64.extend_i32_s (i32.load offset=44 (local.get $desc)))))

  (func $gdi_bitmap_text_prepare_layout (param $text i32) (param $count i32)
        (param $wide i32) (param $format i32) (result i32)
    (local $i i32) (local $out i32) (local $ch i32) (local $next i32)
    (if (i32.gt_u (local.get $count)
          (i32.sub (global.get $GDI_BITMAP_TEXT_LAYOUT_CHARS) (i32.const 4)))
      (then (return (i32.const -1))))
    (block $done (loop $copy
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
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
            (else (local.set $ch (i32.or (local.get $next) (i32.const 0x100)))))
          (local.set $i (i32.add (local.get $i) (i32.const 2))))
        (else (local.set $i (i32.add (local.get $i) (i32.const 1)))))
      (i32.store16 (i32.add (global.get $GDI_BITMAP_TEXT_LAYOUT)
        (i32.shl (local.get $out) (i32.const 1))) (local.get $ch))
      (local.set $out (i32.add (local.get $out) (i32.const 1)))
      (br $copy)))
    (i32.store16 (i32.add (global.get $GDI_BITMAP_TEXT_LAYOUT)
      (i32.shl (local.get $out) (i32.const 1))) (i32.const 0))
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
    (local.set $height (call $gdi_bitmap_font_height
      (local.get $hdc) (local.get $strike)))
    (local.set $average (call $gdi_round_ratio
      (i64.mul (i64.extend_i32_u (i32.load offset=28 (local.get $strike)))
        (i64.extend_i32_u (call $gdi_bitmap_font_width_height
          (local.get $strike) (local.get $height))))
      (i64.extend_i32_u (i32.load offset=20 (local.get $strike)))))
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
          (call $gdi_bitmap_text_measure (local.get $hdc)
            (i32.add (local.get $text) (select
              (local.get $i) (i32.shl (local.get $i) (i32.const 1))
              (i32.eqz (local.get $wide))))
            (i32.const 1) (local.get $wide))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $width))

  ;; Ellipsify one prepared WCHAR line in place. Path ellipsis preserves the
  ;; final slash and tail; end/word ellipsis shortens the visible end.
  (func $gdi_bitmap_text_ellipsify (param $hdc i32) (param $text i32)
        (param $count i32) (param $max_width i32) (param $format i32)
        (param $tab_width i32) (result i32)
    (local $slash i32) (local $i i32) (local $ch i32) (local $tail i32)
    (local $keep i32) (local $measured i32)
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
    (local.get $count))

  (func $gdi_bitmap_text_copy_modified (param $destination i32) (param $text i32)
        (param $count i32) (param $wide i32)
    (local $i i32) (local $ch i32)
    (if (i32.eqz (local.get $destination)) (then (return)))
    (block $done (loop $copy
      (br_if $done (i32.gt_u (local.get $i) (local.get $count)))
      (local.set $ch (i32.and (i32.load16_u (i32.add (local.get $text)
        (i32.shl (local.get $i) (i32.const 1)))) (i32.const 0xFF)))
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
          (call $gdi_bitmap_text_measure (local.get $hdc)
            (i32.add (local.get $text) (select
              (local.get $i) (i32.shl (local.get $i) (i32.const 1))
              (i32.eqz (local.get $wide))))
            (i32.const 1) (local.get $wide))))))
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
    (if (i32.and (local.get $options) (i32.const 2))
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
    (if (i32.eq (call $gdi_dc_get_field (local.get $hdc) (i32.const 28) (i32.const 2)) (i32.const 2))
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
            (then (drop (call $gdi_bitmap_text_pixel_rect (local.get $hdc) (local.get $desc)
              (i32.add (local.get $cursor) (local.get $dx))
              (i32.add (local.get $top) (local.get $dy)) (local.get $text_color)
              (local.get $clip) (local.get $clip_left) (local.get $clip_top)
              (local.get $clip_right) (local.get $clip_bottom)))))
          (local.set $dx (i32.add (local.get $dx) (i32.const 1)))
          (br $glyph_row)))
        (local.set $dy (i32.add (local.get $dy) (i32.const 1)))
        (br $glyph_rows)))
      ;; Prefix markers are private WCHAR bit 8 values produced by DrawText's
      ;; preprocessing pass. Underline the marked glyph on the final cell row.
      (if (i32.and (i32.ne (i32.and (local.get $raw_code) (i32.const 0x100)) (i32.const 0))
            (i32.eqz (local.get $is_tab)))
        (then
          (local.set $dx (i32.const 0))
          (block $underline_done (loop $underline
            (br_if $underline_done (i32.ge_s (local.get $dx) (local.get $glyph_width)))
            (drop (call $gdi_bitmap_text_pixel_rect (local.get $hdc) (local.get $desc)
              (i32.add (local.get $cursor) (local.get $dx))
              (i32.sub (i32.add (local.get $top) (local.get $height)) (i32.const 1))
              (local.get $text_color) (local.get $clip)
              (local.get $clip_left) (local.get $clip_top)
              (local.get $clip_right) (local.get $clip_bottom)))
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
    (call $gdi_geometry_present (local.get $hdc) (local.get $desc)
      (local.get $dirty_left) (local.get $dirty_top)
      (local.get $dirty_right) (local.get $dirty_bottom))
    (i32.const 1))

  (func $gdi_bitmap_draw_text (param $hdc i32) (param $text i32) (param $count i32)
        (param $rect i32) (param $format i32) (param $wide i32) (result i32)
    (local $strike i32) (local $desc i32) (local $height i32)
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
    (if (i32.eqz (local.get $strike)) (then (return (i32.const -1))))
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
    (local.set $height (call $gdi_bitmap_font_height (local.get $hdc) (local.get $strike)))
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
      (global.set $gdi_bitmap_text_active_tab_width (local.get $tab_width))
      (drop (call $gdi_bitmap_text_out (local.get $hdc) (local.get $draw_x)
        (call $gdi_bitmap_text_unmap_y (local.get $desc) (local.get $device_y))
        (local.get $draw_options) (local.get $rect)
        (i32.add (local.get $text) (i32.mul (local.get $pos) (local.get $step)))
        (i32.sub (local.get $end) (local.get $pos)) (i32.const 0) (local.get $wide)))
      (global.set $gdi_bitmap_text_active_tab_width (i32.const 0))
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
