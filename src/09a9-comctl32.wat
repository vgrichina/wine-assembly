  ;; ============================================================
  ;; COMCTL32 HANDLERS
  ;; ImageList, toolbar and status-bar creation, up-down and property-sheet stubs,
  ;; MenuHelp, and the DSA/DPA dynamic-array and pointer-array APIs.
  ;; 
  ;; This was a 680-line slab of comctl32 sitting in the middle of
  ;; 09a-handlers.wat, the file for everything that had nowhere else to go.
  ;; ============================================================

  ;; SHGetFileInfo returns one small and one large system image list for the
  ;; lifetime of a process.  Keep those handles in shared memory: mutable WAT
  ;; globals are instance-local, while guest threads can execute APIs through
  ;; separate Worker instances over the same linear memory.
  (global $SHELL_FILE_INFO i32 (region.addr $SHELL_FILE_INFO 0))
  (global $SHELL_FILE_INFO_SIZE i32 (region.size $SHELL_FILE_INFO))
  (data (region.addr $SHELL_FILE_INFO 0x20)
    "File\00File Folder\00Application\00Local Disk\00Desktop\00My Computer\00Network Neighborhood\00")

  ;; Paint one scaled rectangle into a five-image, 32-bpp top-down strip.
  ;; Coordinates are expressed in a 16x16 design grid so the same classic
  ;; glyphs remain crisp in both system image lists.
  (func $shell_icon_rect
      (param $bits i32) (param $stride i32) (param $size i32) (param $index i32)
      (param $left i32) (param $top i32) (param $right i32) (param $bottom i32)
      (param $color i32)
    (local $x0 i32) (local $x1 i32) (local $y0 i32) (local $y1 i32)
    (local $x i32) (local $y i32) (local $row i32)
    (local.set $x0 (i32.add (i32.mul (local.get $index) (local.get $size))
      (i32.div_u (i32.mul (local.get $left) (local.get $size)) (i32.const 16))))
    (local.set $x1 (i32.add (i32.mul (local.get $index) (local.get $size))
      (i32.div_u (i32.mul (local.get $right) (local.get $size)) (i32.const 16))))
    (local.set $y0
      (i32.div_u (i32.mul (local.get $top) (local.get $size)) (i32.const 16)))
    (local.set $y1
      (i32.div_u (i32.mul (local.get $bottom) (local.get $size)) (i32.const 16)))
    (local.set $y (local.get $y0))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $y1)))
      (local.set $row (i32.add (local.get $bits)
        (i32.mul (local.get $y) (local.get $stride))))
      (local.set $x (local.get $x0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $x1)))
        (i32.store (i32.add (local.get $row) (i32.shl (local.get $x) (i32.const 2)))
          (local.get $color))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows))))

  (func $shell_draw_system_icons (param $bits i32) (param $stride i32) (param $size i32)
    (local $i i32)
    ;; Transparent mask colour, one complete cell at a time.
    (block $background_done (loop $background
      (br_if $background_done (i32.ge_u (local.get $i) (i32.const 5)))
      (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
        (local.get $i) (i32.const 0) (i32.const 0) (i32.const 16) (i32.const 16)
        (i32.const 0x00FF00FF))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $background)))

    ;; 2: generic document, with the folded upper-right corner.
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 2) (i32.const 3) (i32.const 1) (i32.const 13) (i32.const 15) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 2) (i32.const 4) (i32.const 2) (i32.const 12) (i32.const 14) (i32.const 0x00FFFFFF))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 2) (i32.const 9) (i32.const 2) (i32.const 12) (i32.const 6) (i32.const 0x00C0C0C0))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 2) (i32.const 5) (i32.const 9) (i32.const 11) (i32.const 10) (i32.const 0x00808080))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 2) (i32.const 5) (i32.const 11) (i32.const 10) (i32.const 12) (i32.const 0x00808080))

    ;; 1: closed folder.
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 1) (i32.const 1) (i32.const 4) (i32.const 15) (i32.const 14) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 1) (i32.const 2) (i32.const 5) (i32.const 14) (i32.const 13) (i32.const 0x00F0C040))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 1) (i32.const 2) (i32.const 2) (i32.const 8) (i32.const 6) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 1) (i32.const 3) (i32.const 3) (i32.const 7) (i32.const 6) (i32.const 0x00FFFF80))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 1) (i32.const 3) (i32.const 6) (i32.const 13) (i32.const 7) (i32.const 0x00FFFF80))

    ;; 0: open folder; the stepped front lip distinguishes SHGFI_OPENICON.
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 0) (i32.const 1) (i32.const 4) (i32.const 13) (i32.const 13) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 0) (i32.const 2) (i32.const 5) (i32.const 12) (i32.const 12) (i32.const 0x00F0C040))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 0) (i32.const 2) (i32.const 2) (i32.const 8) (i32.const 6) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 0) (i32.const 3) (i32.const 3) (i32.const 7) (i32.const 6) (i32.const 0x00FFFF80))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 0) (i32.const 3) (i32.const 7) (i32.const 15) (i32.const 14) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 0) (i32.const 4) (i32.const 8) (i32.const 14) (i32.const 13) (i32.const 0x00FFFF80))

    ;; 3: application window.
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 3) (i32.const 1) (i32.const 2) (i32.const 15) (i32.const 14) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 3) (i32.const 2) (i32.const 3) (i32.const 14) (i32.const 13) (i32.const 0x00C0C0C0))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 3) (i32.const 3) (i32.const 4) (i32.const 13) (i32.const 7) (i32.const 0x000080C0))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 3) (i32.const 3) (i32.const 8) (i32.const 13) (i32.const 12) (i32.const 0x00FFFFFF))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 3) (i32.const 4) (i32.const 9) (i32.const 7) (i32.const 11) (i32.const 0x00008080))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 3) (i32.const 8) (i32.const 9) (i32.const 12) (i32.const 10) (i32.const 0x00808080))

    ;; 4: local drive.
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 4) (i32.const 1) (i32.const 5) (i32.const 15) (i32.const 13) (i32.const 0x00000000))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 4) (i32.const 2) (i32.const 6) (i32.const 14) (i32.const 12) (i32.const 0x00C0C0C0))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 4) (i32.const 3) (i32.const 6) (i32.const 13) (i32.const 8) (i32.const 0x00FFFFFF))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 4) (i32.const 2) (i32.const 10) (i32.const 14) (i32.const 12) (i32.const 0x00808080))
    (call $shell_icon_rect (local.get $bits) (local.get $stride) (local.get $size)
      (i32.const 4) (i32.const 11) (i32.const 10) (i32.const 13) (i32.const 11) (i32.const 0x0000C000)))

  ;; Return the per-process system image list for one icon size.  Construction
  ;; happens without a lock because bitmap registration calls the host.  A CAS
  ;; publishes the completed object; a rare racing loser tears its candidate
  ;; down instead of exposing a half-initialized shared object or deadlocking a
  ;; browser main thread against a Worker RPC.
  (func $shell_system_image_list (param $size i32) (result i32)
    (local $slot i32) (local $existing i32) (local $candidate i32)
    (local $candidate_wa i32) (local $bits_guest i32) (local $bits i32)
    (local $width i32) (local $stride i32) (local $bitmap i32)
    (local.set $slot (i32.add (global.get $SHELL_FILE_INFO)
      (select (i32.const 0) (i32.const 4) (i32.eq (local.get $size) (i32.const 16)))))
    (local.set $existing (i32.atomic.load (local.get $slot)))
    (if (local.get $existing) (then (return (local.get $existing))))
    (local.set $width (i32.mul (local.get $size) (i32.const 5)))
    (local.set $stride (i32.shl (local.get $width) (i32.const 2)))
    (local.set $bits_guest
      (call $dib_alloc (i32.mul (local.get $stride) (local.get $size))))
    (if (i32.eqz (local.get $bits_guest)) (then (return (i32.const 0))))
    (local.set $bits (call $g2w (local.get $bits_guest)))
    (call $shell_draw_system_icons
      (local.get $bits) (local.get $stride) (local.get $size))
    (local.set $bitmap (call $gdi_bitmap_alloc
      (local.get $width) (local.get $size) (i32.const 32) (i32.const 6)
      (local.get $bits) (local.get $stride) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $bitmap))
      (then
        (call $dib_free_wasm (local.get $bits))
        (return (i32.const 0))))
    (local.set $candidate (call $heap_alloc (i32.const 36)))
    (if (i32.eqz (local.get $candidate))
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (return (i32.const 0))))
    (local.set $candidate_wa (call $g2w (local.get $candidate)))
    (call $zero_memory (local.get $candidate_wa) (i32.const 36))
    (i32.store          (local.get $candidate_wa) (local.get $size))
    (i32.store offset=4 (local.get $candidate_wa) (local.get $size))
    (i32.store offset=8 (local.get $candidate_wa) (i32.const -1)) ;; CLR_NONE
    (i32.store offset=12 (local.get $candidate_wa) (i32.const 5))
    (i32.store offset=16 (local.get $candidate_wa) (local.get $bitmap))
    (i32.store offset=20 (local.get $candidate_wa) (i32.const 0x00FF00FF))
    (i32.store offset=32 (local.get $candidate_wa) (i32.const 0x4C4D4948)) ;; HIML
    (local.set $existing
      (i32.atomic.rmw.cmpxchg (local.get $slot) (i32.const 0) (local.get $candidate)))
    (if (local.get $existing)
      (then
        (drop (call $gdi_object_delete_full (local.get $bitmap)))
        (call $heap_free (local.get $candidate))
        (return (local.get $existing))))
    (local.get $candidate))

  ;; Create the independent HICON promised by ImageList_GetIcon. An entry
  ;; retained by ImageList_ReplaceIcon is copied through USER's normal icon
  ;; ownership path. A bitmap-strip entry is materialized into owned colour
  ;; and 1-bpp AND-mask planes, so arbitrary image-list mask colours remain
  ;; correct after the source list is changed or destroyed.
  (func $image_list_icon_handle (param $list i32) (param $index i32) (result i32)
    (local $sw i32) (local $cx i32) (local $cy i32) (local $icons i32)
    (local $retained i32) (local $source_bitmap i32) (local $mask_key i32)
    (local $source i32) (local $color_desc i32) (local $mask_desc i32)
    (local $color i32) (local $mask i32) (local $mask_stride i32)
    (local $x i32) (local $y i32) (local $pixel i32) (local $result i32)
    (if (i32.eqz (local.get $list)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $list)))
    (if (i32.or
          (i32.ne (i32.load offset=32 (local.get $sw)) (i32.const 0x4C4D4948))
          (i32.ge_u (local.get $index) (i32.load offset=12 (local.get $sw))))
      (then (return (i32.const 0))))
    (local.set $cx (i32.load (local.get $sw)))
    (local.set $cy (i32.load offset=4 (local.get $sw)))
    (if (i32.or
          (i32.or (i32.le_s (local.get $cx) (i32.const 0))
            (i32.gt_s (local.get $cx) (i32.const 256)))
          (i32.or (i32.le_s (local.get $cy) (i32.const 0))
            (i32.gt_s (local.get $cy) (i32.const 256))))
      (then (return (i32.const 0))))
    (local.set $icons (i32.load offset=24 (local.get $sw)))
    (if (i32.and (i32.ne (local.get $icons) (i32.const 0))
          (i32.lt_u (local.get $index) (i32.load offset=28 (local.get $sw))))
      (then
        (local.set $retained (i32.load (call $g2w (i32.add (local.get $icons)
          (i32.shl (local.get $index) (i32.const 2))))))
        (if (local.get $retained)
          (then (return (call $icon_copy_handle (local.get $retained)))))))
    (local.set $source_bitmap (i32.load offset=16 (local.get $sw)))
    (if (i32.or (i32.eqz (local.get $source_bitmap))
          (i32.or
            (i32.lt_s (call $host_gdi_get_object_w (local.get $source_bitmap))
              (i32.mul (i32.add (local.get $index) (i32.const 1)) (local.get $cx)))
            (i32.lt_s (call $host_gdi_get_object_h (local.get $source_bitmap))
              (local.get $cy))))
      (then (return (i32.const 0))))

    ;; Owned 32-bpp colour plane.
    (memory.fill (global.get $GDI_BITMAP_PLAN) (i32.const 0) (i32.const 48))
    (i32.store          (global.get $GDI_BITMAP_PLAN) (local.get $cx))
    (i32.store offset=4 (global.get $GDI_BITMAP_PLAN) (local.get $cy))
    (i32.store offset=8 (global.get $GDI_BITMAP_PLAN) (i32.const 32))
    (i32.store offset=12 (global.get $GDI_BITMAP_PLAN) (i32.const 2)) ;; top-down
    (i32.store offset=16 (global.get $GDI_BITMAP_PLAN)
      (i32.shl (local.get $cx) (i32.const 2)))
    (i32.store offset=32 (global.get $GDI_BITMAP_PLAN)
      (i32.shl (i32.mul (local.get $cx) (local.get $cy)) (i32.const 2)))
    (local.set $color (call $gdi_bitmap_create_owned
      (global.get $GDI_BITMAP_PLAN) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $color)) (then (return (i32.const 0))))

    ;; Owned 1-bpp AND mask. Its rows are DWORD-aligned like a Win32 DDB.
    (local.set $mask_stride (i32.shl
      (i32.shr_u (i32.add (local.get $cx) (i32.const 31)) (i32.const 5))
      (i32.const 2)))
    (memory.fill (global.get $GDI_BITMAP_PLAN) (i32.const 0) (i32.const 48))
    (i32.store          (global.get $GDI_BITMAP_PLAN) (local.get $cx))
    (i32.store offset=4 (global.get $GDI_BITMAP_PLAN) (local.get $cy))
    (i32.store offset=8 (global.get $GDI_BITMAP_PLAN) (i32.const 1))
    (i32.store offset=12 (global.get $GDI_BITMAP_PLAN) (i32.const 2)) ;; top-down
    (i32.store offset=16 (global.get $GDI_BITMAP_PLAN) (local.get $mask_stride))
    (i32.store offset=32 (global.get $GDI_BITMAP_PLAN)
      (i32.mul (local.get $mask_stride) (local.get $cy)))
    (local.set $mask (call $gdi_bitmap_create_owned
      (global.get $GDI_BITMAP_PLAN) (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0)))
    (if (i32.eqz (local.get $mask))
      (then
        (drop (call $gdi_object_delete_full (local.get $color)))
        (return (i32.const 0))))
    (local.set $source (global.get $GDI_BLIT_SRC_DESC))
    (local.set $color_desc (global.get $CURSOR_COLOR_DESC))
    (local.set $mask_desc (global.get $CURSOR_MASK_DESC))
    (if (i32.or
          (i32.eqz (call $gdi_raster_desc_from_bitmap
            (local.get $source_bitmap) (local.get $source)))
          (i32.or
            (i32.eqz (call $gdi_raster_desc_from_bitmap
              (local.get $color) (local.get $color_desc)))
            (i32.eqz (call $gdi_raster_desc_from_bitmap
              (local.get $mask) (local.get $mask_desc)))))
      (then
        (drop (call $gdi_object_delete_full (local.get $mask)))
        (drop (call $gdi_object_delete_full (local.get $color)))
        (return (i32.const 0))))
    (local.set $mask_key (i32.load offset=20 (local.get $sw)))
    ;; CLR_DEFAULT asks common controls to derive transparency from the
    ;; bitmap's upper-left pixel.  gdi_raster_read already returns the
    ;; canonical channel order; an explicit COLORREF still needs conversion.
    (if (i32.eq (local.get $mask_key) (i32.const 0xFF000000))
      (then
        (local.set $mask_key (call $gdi_raster_read (local.get $source)
          (i32.const 0) (i32.const 0))))
      (else
        (if (i32.ne (local.get $mask_key) (i32.const -1))
          (then (local.set $mask_key
            (call $gdi_raster_swap_rb (local.get $mask_key)))))))
    (block $rows_done (loop $rows
      (br_if $rows_done (i32.ge_u (local.get $y) (local.get $cy)))
      (local.set $x (i32.const 0))
      (block $cols_done (loop $cols
        (br_if $cols_done (i32.ge_u (local.get $x) (local.get $cx)))
        (local.set $pixel (call $gdi_raster_read (local.get $source)
          (i32.add (i32.mul (local.get $index) (local.get $cx)) (local.get $x))
          (local.get $y)))
        (if (i32.eq (local.get $pixel) (i32.const -1))
          (then
            (drop (call $gdi_object_delete_full (local.get $mask)))
            (drop (call $gdi_object_delete_full (local.get $color)))
            (return (i32.const 0))))
        (drop (call $gdi_raster_write (local.get $color_desc)
          (local.get $x) (local.get $y) (local.get $pixel)))
        (drop (call $gdi_raster_write_index (local.get $mask_desc)
          (local.get $x) (local.get $y)
          (i32.and (i32.ne (local.get $mask_key) (i32.const -1))
            (i32.eq (local.get $pixel) (local.get $mask_key)))))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $cols)))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $rows)))
    (local.set $result (call $cursor_intern (i32.const 1)
      (i32.shr_u (local.get $cx) (i32.const 1))
      (i32.shr_u (local.get $cy) (i32.const 1))
      (local.get $mask) (local.get $color)))
    (if (i32.eqz (local.get $result))
      (then
        (drop (call $gdi_object_delete_full (local.get $mask)))
        (drop (call $gdi_object_delete_full (local.get $color)))))
    (local.get $result))

  ;; Release an image-list's private HICON array.  The bitmap strip at +16 is
  ;; deliberately not touched: resource-loaded strips are owned by GDI, while
  ;; ImageList_AddMasked copies caller pixels into this private icon array.
  (func $image_list_destroy_icon_array (param $icons i32) (param $count i32)
    (local $icons_wa i32) (local $i i32) (local $icon i32)
    (if (local.get $icons)
      (then
        (local.set $icons_wa (call $g2w (local.get $icons)))
        (block $done (loop $entries
          (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
          (local.set $icon (i32.load (i32.add (local.get $icons_wa)
            (i32.shl (local.get $i) (i32.const 2)))))
          (if (local.get $icon)
            (then (drop (call $icon_destroy_handle (local.get $icon)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $entries)))
        (call $heap_free (local.get $icons)))))

  ;; InitCommonControls() — 0 args, void return, registers common control window classes
  (func $handle_InitCommonControls (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; No-op: our window creation handles class names directly
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; ImageList_Create(cx, cy, flags, cInitial, cGrow) — 5 args, returns HIMAGELIST handle
  (func $handle_ImageList_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $buf_wa i32)
    ;; ImageList struct:
    ;; +0 cx, +4 cy, +8 bk color, +12 count, +16 bitmap strip, +20 mask color,
    ;; +24 icon-handle array, +28 icon-array capacity, +32 validity tag.
    (local.set $buf (call $heap_alloc (i32.const 36)))
    (local.set $buf_wa (call $g2w (local.get $buf)))
    (call $zero_memory (local.get $buf_wa) (i32.const 36))
    (i32.store (local.get $buf_wa) (local.get $arg0))           ;; cx
    (i32.store offset=4 (local.get $buf_wa) (local.get $arg1))  ;; cy
    (i32.store offset=8 (local.get $buf_wa) (i32.const -1))     ;; CLR_NONE
    (i32.store offset=12 (local.get $buf_wa) (i32.const 0))     ;; count=0
    (i32.store offset=32 (local.get $buf_wa) (i32.const 0x4c4d4948)) ;; "HIML"
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; stdcall, 5 args
  )

  ;; ImageList_Destroy(himl) — 1 arg, returns BOOL
  (func $handle_ImageList_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $sw i32) (local $icons i32) (local $count i32)
    (global.set $eax (i32.const 0))
    ;; The lists returned by SHGFI_SYSICONINDEX are shared system resources;
    ;; applications must not destroy them.  Refuse the operation so the stable
    ;; process handles never point at reclaimed heap blocks.
    (if (i32.and (i32.ne (local.get $arg0) (i32.const 0))
          (i32.or
            (i32.eq (local.get $arg0)
              (i32.atomic.load (global.get $SHELL_FILE_INFO)))
            (i32.eq (local.get $arg0)
              (i32.atomic.load offset=4 (global.get $SHELL_FILE_INFO)))))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (if (local.get $arg0)
      (then
        (local.set $sw (call $g2w (local.get $arg0)))
        (if (i32.eq (i32.load offset=32 (local.get $sw)) (i32.const 0x4c4d4948))
          (then
            ;; Invalidate before returning either block to the allocator so a
            ;; duplicate destroy cannot link the same block into the free list.
            (i32.store offset=32 (local.get $sw) (i32.const 0))
            (local.set $icons (i32.load offset=24 (local.get $sw)))
            (i32.store offset=24 (local.get $sw) (i32.const 0))
            (if (local.get $icons)
              (then
                (local.set $count (i32.load offset=12 (local.get $sw)))
                (call $image_list_destroy_icon_array
                  (local.get $icons) (local.get $count))))
            (call $heap_free (local.get $arg0))
            (global.set $eax (i32.const 1))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ImageList_LoadImageA(hi, lpbmp, cx, cGrow, crMask, uType, uFlags) — 7 args
  (func $handle_ImageList_LoadImageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $buf_wa i32) (local $cx i32)
    (local $bmp i32) (local $bmp_w i32) (local $count i32)
    ;; LoadImage returns an image-list wrapper around a bitmap strip when host
    ;; resource loading can resolve the bitmap. If not, still return a valid
    ;; empty image list so callers can proceed.
    (local.set $cx (local.get $arg2))
    (if (i32.le_s (local.get $cx) (i32.const 0))
      (then (local.set $cx (i32.const 16))))
    (local.set $bmp (call $host_gdi_load_bitmap (local.get $arg0) (local.get $arg1)))
    (if (local.get $bmp)
      (then
        (local.set $bmp_w (call $host_gdi_get_object_w (local.get $bmp)))
        (if (i32.gt_s (local.get $bmp_w) (i32.const 0))
          (then
            (local.set $count (i32.div_u (local.get $bmp_w) (local.get $cx)))
            (if (i32.eqz (local.get $count))
              (then (local.set $count (i32.const 1))))))))
    (local.set $buf (call $heap_alloc (i32.const 36)))
    (local.set $buf_wa (call $g2w (local.get $buf)))
    (call $zero_memory (local.get $buf_wa) (i32.const 36))
    (i32.store (local.get $buf_wa) (local.get $cx))           ;; cx
    (i32.store offset=4 (local.get $buf_wa) (local.get $cx))  ;; cy=cx
    (i32.store offset=8 (local.get $buf_wa) (i32.const -1))   ;; CLR_NONE
    (i32.store offset=12 (local.get $buf_wa) (local.get $count))
    (i32.store offset=16 (local.get $buf_wa) (local.get $bmp))
    (i32.store offset=20 (local.get $buf_wa) (local.get $arg4))
    (i32.store offset=32 (local.get $buf_wa) (i32.const 0x4c4d4948))
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))  ;; stdcall, 7 args
  )

  ;; ImageList_LoadImageW — same as A, 7 args
  (func $handle_ImageList_LoadImageW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $buf i32) (local $buf_wa i32) (local $cx i32)
    (local $bmp i32) (local $bmp_w i32) (local $count i32)
    (local.set $cx (local.get $arg2))
    (if (i32.le_s (local.get $cx) (i32.const 0))
      (then (local.set $cx (i32.const 16))))
    (local.set $bmp (call $host_gdi_load_bitmap (local.get $arg0) (local.get $arg1)))
    (if (local.get $bmp)
      (then
        (local.set $bmp_w (call $host_gdi_get_object_w (local.get $bmp)))
        (if (i32.gt_s (local.get $bmp_w) (i32.const 0))
          (then
            (local.set $count (i32.div_u (local.get $bmp_w) (local.get $cx)))
            (if (i32.eqz (local.get $count))
              (then (local.set $count (i32.const 1))))))))
    (local.set $buf (call $heap_alloc (i32.const 36)))
    (local.set $buf_wa (call $g2w (local.get $buf)))
    (call $zero_memory (local.get $buf_wa) (i32.const 36))
    (i32.store (local.get $buf_wa) (local.get $cx))
    (i32.store offset=4 (local.get $buf_wa) (local.get $cx))
    (i32.store offset=8 (local.get $buf_wa) (i32.const -1))
    (i32.store offset=12 (local.get $buf_wa) (local.get $count))
    (i32.store offset=16 (local.get $buf_wa) (local.get $bmp))
    (i32.store offset=20 (local.get $buf_wa) (local.get $arg4))
    (i32.store offset=32 (local.get $buf_wa) (i32.const 0x4c4d4948))
    (global.set $eax (local.get $buf))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; ImageList_AddMasked(himl, hbmImage, crMask) — 3 args, returns image index
  (func $handle_ImageList_AddMasked (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32) (local $cx i32) (local $cy i32)
    (local $bmp_w i32) (local $bmp_h i32) (local $add_count i32)
    (local $new_count i32) (local $capacity i32) (local $sw i32)
    (local $old_icons i32) (local $new_icons i32) (local $new_icons_wa i32)
    (local $probe i32) (local $probe_wa i32)
    (local $i i32) (local $icon i32)
    (global.set $eax (i32.const -1))
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg1)))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $sw (call $g2w (local.get $arg0)))
    (if (i32.ne (i32.load offset=32 (local.get $sw)) (i32.const 0x4C4D4948))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $count (i32.load offset=12 (local.get $sw)))
    (local.set $cx (i32.load (local.get $sw)))
    (local.set $cy (i32.load offset=4 (local.get $sw)))
    (local.set $bmp_w (call $host_gdi_get_object_w (local.get $arg1)))
    (local.set $bmp_h (call $host_gdi_get_object_h (local.get $arg1)))
    (if (i32.or
          (i32.or (i32.le_s (local.get $cx) (i32.const 0))
            (i32.le_s (local.get $cy) (i32.const 0)))
          (i32.or (i32.lt_s (local.get $bmp_w) (local.get $cx))
            (i32.lt_s (local.get $bmp_h) (local.get $cy))))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $add_count (i32.div_u (local.get $bmp_w) (local.get $cx)))
    (local.set $new_count (i32.add (local.get $count) (local.get $add_count)))
    (if (i32.or (i32.lt_u (local.get $new_count) (local.get $count))
          (i32.gt_u (local.get $new_count) (i32.const 0x10000)))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))

    ;; Build the complete replacement array before touching the live list.
    ;; This gives ImageList_AddMasked its documented copy semantics: the
    ;; caller may DeleteObject(hbmImage) immediately after this function.
    (local.set $capacity (i32.const 4))
    (block $capacity_ready (loop $grow_capacity
      (br_if $capacity_ready
        (i32.ge_u (local.get $capacity) (local.get $new_count)))
      (local.set $capacity (i32.shl (local.get $capacity) (i32.const 1)))
      (br $grow_capacity)))
    (local.set $new_icons
      (call $heap_alloc (i32.shl (local.get $capacity) (i32.const 2))))
    (if (i32.eqz (local.get $new_icons))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $new_icons_wa (call $g2w (local.get $new_icons)))
    (call $zero_memory (local.get $new_icons_wa)
      (i32.shl (local.get $capacity) (i32.const 2)))

    ;; Preserve every existing entry, whether it is already an owned HICON or
    ;; still backed by a resource-loaded bitmap strip.
    (block $old_done (loop $old_entries
      (br_if $old_done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $icon
        (call $image_list_icon_handle (local.get $arg0) (local.get $i)))
      (if (i32.eqz (local.get $icon))
        (then
          (call $image_list_destroy_icon_array
            (local.get $new_icons) (local.get $i))
          (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
          (return)))
      (i32.store (i32.add (local.get $new_icons_wa)
        (i32.shl (local.get $i) (i32.const 2))) (local.get $icon))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $old_entries)))

    ;; A small temporary list lets the canonical bitmap-cell extractor apply
    ;; the colour key and create private colour/mask planes for each new cell.
    (local.set $probe (call $heap_alloc (i32.const 36)))
    (if (i32.eqz (local.get $probe))
      (then
        (call $image_list_destroy_icon_array
          (local.get $new_icons) (local.get $count))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $probe_wa (call $g2w (local.get $probe)))
    (call $zero_memory (local.get $probe_wa) (i32.const 36))
    (i32.store          (local.get $probe_wa) (local.get $cx))
    (i32.store offset=4 (local.get $probe_wa) (local.get $cy))
    (i32.store offset=12 (local.get $probe_wa) (local.get $add_count))
    (i32.store offset=16 (local.get $probe_wa) (local.get $arg1))
    (i32.store offset=20 (local.get $probe_wa) (local.get $arg2))
    (i32.store offset=32 (local.get $probe_wa) (i32.const 0x4C4D4948))
    (local.set $i (i32.const 0))
    (block $new_done (loop $new_entries
      (br_if $new_done (i32.ge_u (local.get $i) (local.get $add_count)))
      (local.set $icon
        (call $image_list_icon_handle (local.get $probe) (local.get $i)))
      (if (i32.eqz (local.get $icon))
        (then
          (call $heap_free (local.get $probe))
          (call $image_list_destroy_icon_array
            (local.get $new_icons) (i32.add (local.get $count) (local.get $i)))
          (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
          (return)))
      (i32.store (i32.add (local.get $new_icons_wa)
        (i32.shl (i32.add (local.get $count) (local.get $i)) (i32.const 2)))
        (local.get $icon))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $new_entries)))
    (call $heap_free (local.get $probe))

    (local.set $old_icons (i32.load offset=24 (local.get $sw)))
    (call $image_list_destroy_icon_array
      (local.get $old_icons) (local.get $count))
    (i32.store offset=12 (local.get $sw) (local.get $new_count))
    (i32.store offset=16 (local.get $sw) (i32.const 0))
    (i32.store offset=20 (local.get $sw) (i32.const -1))
    (i32.store offset=24 (local.get $sw) (local.get $new_icons))
    (i32.store offset=28 (local.get $sw) (local.get $capacity))
    (global.set $eax (local.get $count))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; ImageList_ReplaceIcon(himl, i, hicon) — replace an existing image, or
  ;; append when i == -1. Returns the resulting image index, or -1 on error.
  (func $handle_ImageList_ReplaceIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $sw i32) (local $count i32) (local $index i32)
    (local $icons i32) (local $icons_wa i32) (local $capacity i32)
    (local $new_icons i32) (local $new_icons_wa i32) (local $new_capacity i32)
    (local $copy i32) (local $old i32)
    (global.set $eax (i32.const -1))
    (if (i32.or (i32.eqz (local.get $arg0)) (i32.eqz (local.get $arg2)))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $sw (call $g2w (local.get $arg0)))
    (local.set $count (i32.load offset=12 (local.get $sw)))
    (local.set $index (local.get $arg1))
    (if (i32.eq (local.get $index) (i32.const -1))
      (then (local.set $index (local.get $count)))
      (else
        (if (i32.ge_u (local.get $index) (local.get $count))
          (then
            (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
            (return)))))
    ;; Common controls copies the icon's image and mask; it never retains the
    ;; caller's HICON. This private copy lets the caller destroy hicon as soon
    ;; as ImageList_ReplaceIcon returns, exactly as the Win32 contract allows.
    (local.set $copy (call $icon_copy_handle (local.get $arg2)))
    (if (i32.eqz (local.get $copy))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $icons (i32.load offset=24 (local.get $sw)))
    (if (local.get $icons)
      (then (local.set $icons_wa (call $g2w (local.get $icons)))))
    (local.set $capacity (i32.load offset=28 (local.get $sw)))
    (if (i32.ge_u (local.get $index) (local.get $capacity))
      (then
        (local.set $new_capacity (i32.shl (local.get $capacity) (i32.const 1)))
        (if (i32.lt_u (local.get $new_capacity) (i32.const 4))
          (then (local.set $new_capacity (i32.const 4))))
        (if (i32.le_u (local.get $new_capacity) (local.get $index))
          (then (local.set $new_capacity (i32.add (local.get $index) (i32.const 1)))))
        ;; A bitmap-backed list can already expose many cells without an icon
        ;; array.  Replacing any one cell needs addressable slots for every
        ;; logical image, otherwise GetIcon/Destroy would read past capacity.
        (if (i32.lt_u (local.get $new_capacity) (local.get $count))
          (then (local.set $new_capacity (local.get $count))))
        (local.set $new_icons
          (call $heap_alloc (i32.shl (local.get $new_capacity) (i32.const 2))))
        (if (i32.eqz (local.get $new_icons))
          (then
            (drop (call $icon_destroy_handle (local.get $copy)))
            (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
            (return)))
        (local.set $new_icons_wa (call $g2w (local.get $new_icons)))
        (call $zero_memory (local.get $new_icons_wa)
          (i32.shl (local.get $new_capacity) (i32.const 2)))
        (if (local.get $icons)
          (then
            (call $memcpy (local.get $new_icons_wa) (local.get $icons_wa)
              (i32.shl (local.get $capacity) (i32.const 2)))))
        (local.set $icons (local.get $new_icons))
        (local.set $icons_wa (local.get $new_icons_wa))
        (local.set $capacity (local.get $new_capacity))
        (i32.store offset=24 (local.get $sw) (local.get $icons))
        (i32.store offset=28 (local.get $sw) (local.get $capacity))))
    (if (i32.lt_u (local.get $index) (local.get $count))
      (then
        (local.set $old (i32.load (i32.add (local.get $icons_wa)
          (i32.shl (local.get $index) (i32.const 2)))))
        (if (local.get $old)
          (then (drop (call $icon_destroy_handle (local.get $old)))))))
    (i32.store (i32.add (local.get $icons_wa)
      (i32.shl (local.get $index) (i32.const 2))) (local.get $copy))
    (if (i32.eq (local.get $index) (local.get $count))
      (then (i32.store offset=12 (local.get $sw) (i32.add (local.get $count) (i32.const 1)))))
    (global.set $eax (local.get $index))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; ImageList_GetIcon(himl, i, flags) — create an independent HICON from the
  ;; entry's image and mask. The caller owns the result and releases it with
  ;; DestroyIcon. ILD_NORMAL/ILD_TRANSPARENT share the same stored planes;
  ;; overlay/blend styling remains a draw-time compatibility extension.
  (func $handle_ImageList_GetIcon (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $image_list_icon_handle (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; ImageList_Remove(himl, i) — remove one image and close the index gap, or
  ;; remove every image when i == -1.  Rebuild through owned HICONs before
  ;; mutating the live list so a bitmap-backed list remains unchanged if any
  ;; source cell cannot be materialized.
  (func $handle_ImageList_Remove (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $sw i32) (local $count i32) (local $new_count i32)
    (local $old_icons i32) (local $new_icons i32) (local $new_icons_wa i32)
    (local $capacity i32) (local $source_index i32) (local $dest_index i32)
    (local $icon i32)
    (global.set $eax (i32.const 0))
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    ;; SHGFI_SYSICONINDEX lists are shared process resources and cannot be
    ;; changed by applications.
    (if (i32.or
          (i32.eq (local.get $arg0)
            (i32.atomic.load (global.get $SHELL_FILE_INFO)))
          (i32.eq (local.get $arg0)
            (i32.atomic.load offset=4 (global.get $SHELL_FILE_INFO))))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $sw (call $g2w (local.get $arg0)))
    (if (i32.ne (i32.load offset=32 (local.get $sw)) (i32.const 0x4C4D4948))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $count (i32.load offset=12 (local.get $sw)))
    (local.set $old_icons (i32.load offset=24 (local.get $sw)))

    (if (i32.eq (local.get $arg1) (i32.const -1))
      (then
        (call $image_list_destroy_icon_array
          (local.get $old_icons) (local.get $count))
        (i32.store offset=12 (local.get $sw) (i32.const 0))
        (i32.store offset=16 (local.get $sw) (i32.const 0))
        (i32.store offset=20 (local.get $sw) (i32.const -1))
        (i32.store offset=24 (local.get $sw) (i32.const 0))
        (i32.store offset=28 (local.get $sw) (i32.const 0))
        (global.set $eax (i32.const 1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (if (i32.ge_u (local.get $arg1) (local.get $count))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))

    (local.set $new_count (i32.sub (local.get $count) (i32.const 1)))
    (if (local.get $new_count)
      (then
        (local.set $capacity (i32.const 4))
        (block $capacity_ready (loop $grow_capacity
          (br_if $capacity_ready
            (i32.ge_u (local.get $capacity) (local.get $new_count)))
          (local.set $capacity
            (i32.shl (local.get $capacity) (i32.const 1)))
          (br $grow_capacity)))
        (local.set $new_icons
          (call $heap_alloc (i32.shl (local.get $capacity) (i32.const 2))))
        (if (i32.eqz (local.get $new_icons))
          (then
            (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
            (return)))
        (local.set $new_icons_wa (call $g2w (local.get $new_icons)))
        (call $zero_memory (local.get $new_icons_wa)
          (i32.shl (local.get $capacity) (i32.const 2)))
        (block $done (loop $entries
          (br_if $done
            (i32.ge_u (local.get $source_index) (local.get $count)))
          (if (i32.ne (local.get $source_index) (local.get $arg1))
            (then
              (local.set $icon (call $image_list_icon_handle
                (local.get $arg0) (local.get $source_index)))
              (if (i32.eqz (local.get $icon))
                (then
                  (call $image_list_destroy_icon_array
                    (local.get $new_icons) (local.get $dest_index))
                  (global.set $esp
                    (i32.add (global.get $esp) (i32.const 12)))
                  (return)))
              (i32.store (i32.add (local.get $new_icons_wa)
                (i32.shl (local.get $dest_index) (i32.const 2)))
                (local.get $icon))
              (local.set $dest_index
                (i32.add (local.get $dest_index) (i32.const 1)))))
          (local.set $source_index
            (i32.add (local.get $source_index) (i32.const 1)))
          (br $entries)))))

    (call $image_list_destroy_icon_array
      (local.get $old_icons) (local.get $count))
    (i32.store offset=12 (local.get $sw) (local.get $new_count))
    (i32.store offset=16 (local.get $sw) (i32.const 0))
    (i32.store offset=20 (local.get $sw) (i32.const -1))
    (i32.store offset=24 (local.get $sw) (local.get $new_icons))
    (i32.store offset=28 (local.get $sw) (local.get $capacity))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  (func $create_status_window
    (param $style i32) (param $text_wa i32) (param $parent i32) (param $id i32)
    (result i32)
    (local $hwnd i32)
    (local.set $hwnd (call $ctrl_create_child
      (local.get $parent) (i32.const 22) (local.get $id)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 20)
      (local.get $style) (i32.const 0)))
    (drop (call $host_create_window
      (local.get $hwnd) (local.get $style)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 20)
      (local.get $text_wa) (local.get $id)))
    (call $host_set_parent (local.get $hwnd) (local.get $parent))
    (call $host_set_window_class (local.get $hwnd) (region.addr $CLASS_NAME_STRINGS 0x160))
    (local.get $hwnd))

  ;; CreateStatusWindowA(style, lpszText, hwndParent, wID) — 4 args, returns HWND
  (func $handle_CreateStatusWindowA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $create_status_window
      (local.get $arg0)
      (if (result i32) (local.get $arg1) (then (call $g2w (local.get $arg1))) (else (i32.const 0)))
      (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; CreateToolbarEx — 13 args, returns HWND of toolbar
  (func $handle_CreateToolbarEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateToolbarEx(hwndParent, ws, wID, nBitmaps, hBMInst, wBMID, lpButtons, iNumButtons, dxButton, dyButton, dxBitmap, dyBitmap, uStructSize)
    (local $wa_esp i32) (local $hwnd i32) (local $state i32) (local $sw i32)
    (local $buttons i32) (local $button_count i32) (local $button_w i32) (local $button_h i32)
    (local $bitmap_w i32) (local $bitmap_h i32) (local $struct_size i32) (local $bmp i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $buttons (i32.load offset=28 (local.get $wa_esp)))
    (local.set $button_count (i32.load offset=32 (local.get $wa_esp)))
    (local.set $button_w (i32.load offset=36 (local.get $wa_esp)))
    (local.set $button_h (i32.load offset=40 (local.get $wa_esp)))
    (local.set $bitmap_w (i32.load offset=44 (local.get $wa_esp)))
    (local.set $bitmap_h (i32.load offset=48 (local.get $wa_esp)))
    (local.set $struct_size (i32.load offset=52 (local.get $wa_esp)))
    ;; Win9x common controls treat these as requested image/button extents,
    ;; then retain the standard face padding around the bitmap. Media Player
    ;; passes equal 16x16 values and expects the familiar 23x22 transport
    ;; buttons, not tightly cropped 16x16 faces.
    (if (i32.le_u (local.get $button_w) (local.get $bitmap_w))
      (then (local.set $button_w (i32.add (local.get $bitmap_w) (i32.const 7)))))
    (if (i32.le_u (local.get $button_h) (local.get $bitmap_h))
      (then (local.set $button_h (i32.add (local.get $bitmap_h) (i32.const 6)))))
    ;; Create a real class-21 child so SendMessage routes through the toolbar
    ;; control model. The old renderer-only HWND had no parent/control state,
    ;; causing Media Player's layout messages to enter its application wndproc.
    (local.set $hwnd (call $ctrl_create_child
      (local.get $arg0) (i32.const 21) (local.get $arg2)
      (i32.const 0) (i32.const 0) (i32.const 100) (i32.const 30)
      (local.get $arg1) (i32.const 0)))
    (drop (call $host_create_window
      (local.get $hwnd) (local.get $arg1)
      (i32.const 0) (i32.const 0) (i32.const 100) (i32.const 30)
      (i32.const 0) (local.get $arg2)))
    (call $wnd_set_parent (local.get $hwnd) (local.get $arg0))
    (call $host_set_parent (local.get $hwnd) (local.get $arg0))
    (call $host_set_window_class (local.get $hwnd) (region.addr $CLASS_NAME_STRINGS 0x174))
    (local.set $state (call $toolbar_ensure_state (local.get $hwnd)))
    (local.set $sw (call $g2w (local.get $state)))
    (if (local.get $button_w) (then (i32.store offset=4 (local.get $sw) (local.get $button_w))))
    (if (local.get $button_h) (then (i32.store offset=8 (local.get $sw) (local.get $button_h))))
    (if (local.get $bitmap_w) (then (i32.store offset=12 (local.get $sw) (local.get $bitmap_w))))
    (if (local.get $bitmap_h) (then (i32.store offset=16 (local.get $sw) (local.get $bitmap_h))))
    (if (local.get $struct_size) (then (i32.store offset=24 (local.get $sw) (local.get $struct_size))))
    ;; CreateToolbarEx supplies the initial strip directly instead of sending
    ;; TB_ADDBITMAP. Load it here so the copied iBitmap indices have pixels.
    (if (local.get $arg3)
      (then
        (local.set $bmp (call $host_gdi_load_bitmap (local.get $arg4)
          (i32.and (i32.load offset=24 (local.get $wa_esp)) (i32.const 0xFFFF))))
        (if (local.get $bmp)
          (then
            (i32.store offset=48 (local.get $sw) (local.get $bmp))
            (i32.store offset=28 (local.get $sw) (local.get $arg3))))))
    (if (i32.and
          (i32.ne (local.get $buttons) (i32.const 0))
          (i32.ne (local.get $button_count) (i32.const 0)))
      (then
        (drop (call $toolbar_ensure_capacity (local.get $sw) (local.get $button_count)))
        (local.set $state (i32.const 0))
        (block $done (loop $copy
          (br_if $done (i32.ge_u (local.get $state) (local.get $button_count)))
          (call $toolbar_copy_button_in
            (call $toolbar_button_ptr (local.get $sw) (local.get $state))
            (i32.add (local.get $buttons) (i32.mul (local.get $state) (local.get $struct_size)))
            (local.get $struct_size) (local.get $state))
          (local.set $state (i32.add (local.get $state) (i32.const 1)))
          (br $copy)))
        (i32.store (local.get $sw) (local.get $button_count))))
    (call $toolbar_autosize (local.get $hwnd))
    (global.set $eax (local.get $hwnd))
    (global.set $esp (i32.add (global.get $esp) (i32.const 56)))  ;; stdcall, 13 args
  )

  ;; CreateUpDownControl — 12 args, returns HWND
  (func $handle_CreateUpDownControl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; CreateUpDownControl(dwStyle, x, y, cx, cy, hParent, nID, hInst, hBuddy, nUpper, nLower, nPos)
    (global.set $eax (call $host_create_window
      (global.get $next_hwnd)
      (local.get $arg0) ;; style
      (local.get $arg1) ;; x
      (local.get $arg2) ;; y
      (local.get $arg3) ;; cx
      (local.get $arg4) ;; cy
      (i32.const 0) ;; no text
      (i32.const 0)))
    (global.set $next_hwnd (i32.add (global.get $next_hwnd) (i32.const 1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 52)))  ;; stdcall, 12 args
  )

  ;; GetEffectiveClientRect(hWnd, lprc, lpInfo) — 3 args, void
  (func $handle_GetEffectiveClientRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Calculates the client rect excluding toolbars/status bars
    ;; For now, just call GetClientRect equivalent — fill rect with window client area
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (i32.store (local.get $wa) (i32.const 0))          ;; left
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0))  ;; top
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 640))  ;; right
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 480)) ;; bottom
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DrawStatusTextA(hDC, lprc, pszText, uFlags) — 4 args, void
  (func $handle_DrawStatusTextA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Draw text through the supplied HDC so the child-window origin and clip
    ;; match USER/GDI. Comctl32 DrawStatusText uses a recessed border; for now
    ;; preserve the app-provided rect and flags, but avoid the old global
    ;; renderer text path.
    (if (local.get $arg2)
      (then
        (drop (call $host_gdi_draw_text
          (local.get $arg0) ;; hDC
          (call $g2w (local.get $arg2)) ;; text
          (i32.const -1) ;; nCount=-1 (null terminated)
          (call $g2w (local.get $arg1)) ;; lpRect
          (i32.or (local.get $arg3) (i32.const 0x24)) ;; DT_SINGLELINE|DT_VCENTER
          (i32.const 0))))) ;; ANSI
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; DrawStatusTextW — 4 args, void. Same draw as the A spelling, with the
  ;; text read as UTF-16; it used to skip the draw entirely, so a wide app's
  ;; status bar stayed blank.
  (func $handle_DrawStatusTextW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg2)
      (then
        (drop (call $host_gdi_draw_text
          (local.get $arg0)                              ;; hDC
          (call $g2w (local.get $arg2))                  ;; text
          (i32.const -1)                                 ;; nCount=-1 (null terminated)
          (call $g2w (local.get $arg1))                  ;; lpRect
          (i32.or (local.get $arg3) (i32.const 0x24))    ;; DT_SINGLELINE|DT_VCENTER
          (i32.const 1)))))                              ;; wide
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; MenuHelp(uMsg, wParam, lParam, hMainMenu, hInst) — 5 args, void
  (func $handle_MenuHelp (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Processes WM_MENUSELECT and WM_COMMAND for status bar help text — no-op
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; ShowHideMenuCtl(hWnd, uFlags, lpInfo) — 3 args, returns BOOL
  (func $handle_ShowHideMenuCtl (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; CreateMappedBitmap(hInstance, idBitmap, wFlags, lpColorMap, iNumMaps) — 5 args, returns HBITMAP
  (func $handle_CreateMappedBitmap (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32)
    ;; Bounded compatibility: load the requested RT_BITMAP and skip the
    ;; optional comctl32 color map for now. Returning a real HBITMAP matters
    ;; more than the previous fake handle because toolbar/image painters can
    ;; validate and blit it.
    (local.set $tmp
      (call $host_gdi_load_bitmap
        (local.get $arg0)
        (if (result i32) (i32.gt_u (local.get $arg1) (i32.const 0xFFFF))
          (then (local.get $arg1))
          (else (i32.and (local.get $arg1) (i32.const 0xFFFF))))))
    (if (i32.eqz (local.get $tmp))
      (then
        (local.set $tmp
          (call $host_gdi_create_compat_bitmap
            (i32.const 0) (i32.const 16) (i32.const 16) (i32.const 0)))))
    (global.set $eax (local.get $tmp))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; CreatePropertySheetPageA(lppsp) — 1 arg, returns HPROPSHEETPAGE
  (func $handle_CreatePropertySheetPageA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return a fake handle
    (local.set $arg0 (call $heap_alloc (i32.const 4)))
    (global.set $eax (local.get $arg0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; PropertySheetA(lppsph) — 1 arg, returns int (>0 if user clicked OK).
  ;; The frame and guest-backed pages are built by the USER control layer;
  ;; park this synchronous API on the same modal pump as the common dialogs.
  (func $handle_PropertySheetA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dlg i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (call $modal_capture_nonvolatile)
    (local.set $dlg (call $create_property_sheet (local.get $arg0)))
    (if (i32.eqz (local.get $dlg))
      (then
        (global.set $modal_restore_pending (i32.const 0))
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (call $modal_begin (local.get $dlg) (i32.const 8))
  )

  ;; ImageList_SetBkColor(himl, clrBk) — 2 args, returns old bk color
  (func $handle_ImageList_SetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $old i32) (local $bk_wa i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
        (return)))
    (local.set $bk_wa (call $g2w (i32.add (local.get $arg0) (i32.const 8))))
    (local.set $old (i32.load (local.get $bk_wa)))
    (i32.store (local.get $bk_wa) (local.get $arg1))
    (global.set $eax (local.get $old))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ImageList_GetBkColor(himl) — 1 arg
  (func $handle_ImageList_GetBkColor (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then
        (global.set $eax (i32.const -1))
        (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
        (return)))
    (global.set $eax (i32.load (call $g2w (i32.add (local.get $arg0) (i32.const 8)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; CreateStatusWindowW — same as A version, 4 args
  (func $handle_CreateStatusWindowW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; The renderer string bridge is ANSI; the app sets status text later via
    ;; messages, so create the Unicode control with an initially empty title.
    (global.set $eax (call $create_status_window
      (local.get $arg0) (i32.const 0) (local.get $arg2) (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; ============================================================
  ;; COMCTL32 internal heap functions (ordinal-only)
  ;; ============================================================

  ;; Comctl32_Alloc(dwSize) — 1 arg, returns pointer (zeroed)
  (func $handle_Comctl32_Alloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ptr i32)
    (local.set $ptr (call $heap_alloc (local.get $arg0)))
    ;; Zero the allocation
    (if (local.get $arg0)
      (then (memory.fill (call $g2w (local.get $ptr)) (i32.const 0) (local.get $arg0))))
    (global.set $eax (local.get $ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; Comctl32_ReAlloc(pv, cbNew) — 2 args, returns pointer
  (func $handle_Comctl32_ReAlloc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Simple: allocate new, copy, return new (no free of old — heap doesn't support free yet)
    (local $new_ptr i32)
    (if (i32.eqz (local.get $arg0))
      (then
        ;; NULL input = just alloc
        (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
        (if (local.get $arg1)
          (then (memory.fill (call $g2w (local.get $new_ptr)) (i32.const 0) (local.get $arg1)))))
      (else
        ;; Realloc: alloc new, copy old data
        (local.set $new_ptr (call $heap_alloc (local.get $arg1)))
        (if (local.get $arg1)
          (then (memory.copy (call $g2w (local.get $new_ptr)) (call $g2w (local.get $arg0)) (local.get $arg1))))))
    (global.set $eax (local.get $new_ptr))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; Comctl32_Free(pv) — 1 arg, returns BOOL
  (func $handle_Comctl32_Free (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Our heap doesn't support free, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; Comctl32_GetSize(pv) — 1 arg, returns DWORD size
  (func $handle_Comctl32_GetSize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Our heap doesn't track sizes, return a reasonable default
    (global.set $eax (i32.const 256))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; ============================================================
  ;; DSA (Dynamic Structure Array) — real implementation
  ;; DSA layout in memory: [item_size:4, count:4, capacity:4, data_ptr:4]
  ;; ============================================================

  ;; DSA_Create(cbItem, cItemGrow) — 2 args, returns HDSA
  (func $handle_DSA_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dsa i32) (local $dsa_wa i32)
    (local $cap i32)
    (local.set $cap (select (local.get $arg1) (i32.const 8) (i32.gt_u (local.get $arg1) (i32.const 0))))
    (local.set $dsa (call $heap_alloc (i32.const 16))) (local.set $dsa_wa (call $g2w (local.get $dsa)))
    (i32.store (local.get $dsa_wa) (local.get $arg0))           ;; item_size
    (i32.store offset=4 (local.get $dsa_wa) (i32.const 0))  ;; count
    (i32.store offset=8 (local.get $dsa_wa) (local.get $cap))  ;; capacity
    ;; Allocate data buffer: capacity * item_size
    (i32.store offset=12 (local.get $dsa_wa)
      (call $heap_alloc (i32.mul (local.get $cap) (local.get $arg0))))
    (global.set $eax (local.get $dsa))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DSA_Destroy(hdsa) — 1 arg, returns BOOL
  (func $handle_DSA_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Can't free, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DSA_GetItem(hdsa, index, pitem) — 3 args, returns BOOL
  (func $handle_DSA_GetItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32) (local $dsa_wa i32)
    (local $data_ptr i32)
    (local $count i32)
    (local.set $dsa_wa (call $g2w (local.get $arg0)))
    (local.set $item_size (i32.load (local.get $dsa_wa)))
    (local.set $count (i32.load offset=4 (local.get $dsa_wa)))
    (local.set $data_ptr (i32.load offset=12 (local.get $dsa_wa)))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        ;; Copy item_size bytes from data[index*item_size] to pitem
        (memory.copy (call $g2w (local.get $arg2))
          (call $g2w (i32.add (local.get $data_ptr) (i32.mul (local.get $arg1) (local.get $item_size))))
          (local.get $item_size))
        (global.set $eax (i32.const 1)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DSA_GetItemPtr(hdsa, index) — 2 args, returns pointer to item
  (func $handle_DSA_GetItemPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32) (local $dsa_wa i32)
    (local $data_ptr i32)
    (local $count i32)
    (local.set $dsa_wa (call $g2w (local.get $arg0)))
    (local.set $item_size (i32.load (local.get $dsa_wa)))
    (local.set $count (i32.load offset=4 (local.get $dsa_wa)))
    (local.set $data_ptr (i32.load offset=12 (local.get $dsa_wa)))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (global.set $eax (i32.add (local.get $data_ptr) (i32.mul (local.get $arg1) (local.get $item_size)))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DSA_InsertItem(hdsa, index, pitem) — 3 args, returns index or -1
  ;; Callers index a DSA in lockstep with a parallel list control — Task
  ;; Manager reads row N of its listbox and asks the DSA for item N — so an
  ;; insert in the middle has to move the later items up rather than overwrite
  ;; the one already there, and has to grow the buffer instead of running off
  ;; the end of it once the initial capacity fills.
  (func $handle_DSA_InsertItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32) (local $dsa_wa i32) (local $data_wa i32)
    (local $count i32)
    (local $cap i32)
    (local $data_ptr i32)
    (local $idx i32)
    (local $new_cap i32)
    (local $new_data i32) (local $new_data_wa i32)
    (local.set $dsa_wa (call $g2w (local.get $arg0)))
    (local.set $item_size (i32.load (local.get $dsa_wa)))
    (local.set $count (i32.load offset=4 (local.get $dsa_wa)))
    (local.set $cap (i32.load offset=8 (local.get $dsa_wa)))
    (local.set $data_ptr (i32.load offset=12 (local.get $dsa_wa))) (local.set $data_wa (call $g2w (local.get $data_ptr)))
    ;; Clamp index: if index > count or DA_LAST (0x7FFFFFFF), append
    (local.set $idx (select (local.get $count) (local.get $arg1)
      (i32.gt_u (local.get $arg1) (local.get $count))))
    ;; Grow first so the extra slot exists before the shift.
    (if (i32.ge_u (local.get $count) (local.get $cap))
      (then
        (local.set $new_cap (i32.shl (local.get $cap) (i32.const 1)))
        (if (i32.lt_u (local.get $new_cap) (i32.const 8))
          (then (local.set $new_cap (i32.const 8))))
        (local.set $new_data (call $heap_alloc (i32.mul (local.get $new_cap) (local.get $item_size)))) (local.set $new_data_wa (call $g2w (local.get $new_data)))
        (if (local.get $count)
          (then
            (memory.copy (local.get $new_data_wa) (local.get $data_wa)
              (i32.mul (local.get $count) (local.get $item_size)))))
        (if (local.get $data_ptr) (then (call $heap_free (local.get $data_ptr))))
        (local.set $data_ptr (local.get $new_data)) (local.set $data_wa (local.get $new_data_wa))
        (i32.store offset=8 (local.get $dsa_wa) (local.get $new_cap))
        (i32.store offset=12 (local.get $dsa_wa) (local.get $new_data))))
    ;; Shift [idx, count) up one slot. memory.copy is defined to behave like
    ;; memmove, so the overlap here is safe.
    (if (i32.gt_u (local.get $count) (local.get $idx))
      (then
        (memory.copy
          (i32.add (local.get $data_wa)
            (i32.mul (i32.add (local.get $idx) (i32.const 1)) (local.get $item_size)))
          (i32.add (local.get $data_wa) (i32.mul (local.get $idx) (local.get $item_size)))
          (i32.mul (i32.sub (local.get $count) (local.get $idx)) (local.get $item_size)))))
    ;; Copy item data to data[idx * item_size]
    (memory.copy
      (i32.add (local.get $data_wa) (i32.mul (local.get $idx) (local.get $item_size)))
      (call $g2w (local.get $arg2))
      (local.get $item_size))
    ;; Increment count
    (i32.store offset=4 (local.get $dsa_wa)
      (i32.add (local.get $count) (i32.const 1)))
    (global.set $eax (local.get $idx))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DSA_DeleteItem(hdsa, index) — 2 args, returns BOOL
  ;; Removing item N must close the gap. Only decrementing the count drops the
  ;; LAST item logically while every index from N on still reads its old
  ;; neighbour — which is how Task Manager's End Task came to act on the row
  ;; above the one the user had selected.
  (func $handle_DSA_DeleteItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $item_size i32) (local $dsa_wa i32) (local $data_wa i32)
    (local $count i32)
    (local $data_ptr i32)
    (local.set $dsa_wa (call $g2w (local.get $arg0)))
    (local.set $item_size (i32.load (local.get $dsa_wa)))
    (local.set $count (i32.load offset=4 (local.get $dsa_wa)))
    (local.set $data_ptr (i32.load offset=12 (local.get $dsa_wa))) (local.set $data_wa (call $g2w (local.get $data_ptr)))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        ;; Shift (index, count) down over the removed slot.
        (if (i32.gt_u (i32.sub (local.get $count) (i32.const 1)) (local.get $arg1))
          (then
            (memory.copy
              (i32.add (local.get $data_wa) (i32.mul (local.get $arg1) (local.get $item_size)))
              (i32.add (local.get $data_wa)
                (i32.mul (i32.add (local.get $arg1) (i32.const 1)) (local.get $item_size)))
              (i32.mul (i32.sub (i32.sub (local.get $count) (i32.const 1)) (local.get $arg1))
                (local.get $item_size)))))
        (i32.store offset=4 (local.get $dsa_wa)
          (i32.sub (local.get $count) (i32.const 1)))
        (global.set $eax (i32.const 1)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; ============================================================
  ;; DPA (Dynamic Pointer Array) — real implementation
  ;; DPA layout: [count:4, capacity:4, ptrs_ptr:4]
  ;; ============================================================

  ;; DPA_Create(cItemGrow) — 1 arg, returns HDPA
  (func $handle_DPA_Create (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dpa i32) (local $dpa_wa i32)
    (local $cap i32)
    (local.set $cap (select (local.get $arg0) (i32.const 8) (i32.gt_u (local.get $arg0) (i32.const 0))))
    (local.set $dpa (call $heap_alloc (i32.const 12))) (local.set $dpa_wa (call $g2w (local.get $dpa)))
    (i32.store (local.get $dpa_wa) (i32.const 0))           ;; count
    (i32.store offset=4 (local.get $dpa_wa) (local.get $cap))  ;; capacity
    (i32.store offset=8 (local.get $dpa_wa)
      (call $heap_alloc (i32.shl (local.get $cap) (i32.const 2))))   ;; ptrs array
    (global.set $eax (local.get $dpa))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DPA_Destroy(hdpa) — 1 arg, returns BOOL
  (func $handle_DPA_Destroy (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; DPA_GetPtr(hdpa, index) — 2 args, returns pointer at index
  (func $handle_DPA_GetPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32) (local $dpa_wa i32)
    (local $ptrs i32)
    (local.set $dpa_wa (call $g2w (local.get $arg0)))
    (local.set $count (i32.load (local.get $dpa_wa)))
    (local.set $ptrs (i32.load offset=8 (local.get $dpa_wa)))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (global.set $eax (i32.load (call $g2w (i32.add (local.get $ptrs) (i32.shl (local.get $arg1) (i32.const 2)))))))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DPA_InsertPtr(hdpa, index, p) — 3 args, returns index or -1
  ;; A DPA is an ordered array, and callers index it in lockstep with a
  ;; parallel list control: Task Manager reads row N of its listbox and asks
  ;; the DPA for element N. So an insert must move the later elements up
  ;; rather than overwrite the one already at that slot, and must grow the
  ;; backing array instead of writing past it once the initial capacity fills.
  (func $handle_DPA_InsertPtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $cap i32)
    (local $ptrs i32)
    (local $idx i32)
    (local $i i32)
    (local $new_cap i32)
    (local $new_ptrs i32)
    (local $dpa_wa i32) (local $ptrs_wa i32) (local $new_ptrs_wa i32)
    (local.set $dpa_wa (call $g2w (local.get $arg0)))
    (local.set $count (i32.load (local.get $dpa_wa)))
    (local.set $cap (i32.load offset=4 (local.get $dpa_wa)))
    (local.set $ptrs (i32.load offset=8 (local.get $dpa_wa)))
    (if (local.get $ptrs)
      (then (local.set $ptrs_wa (call $g2w (local.get $ptrs)))))
    ;; DPA_APPEND (0x7FFFFFFF) and any out-of-range index append.
    (local.set $idx (select (local.get $count) (local.get $arg1)
      (i32.gt_u (local.get $arg1) (local.get $count))))
    ;; Grow before the shift so the extra slot exists.
    (if (i32.ge_u (local.get $count) (local.get $cap))
      (then
        (local.set $new_cap (i32.shl (local.get $cap) (i32.const 1)))
        (if (i32.lt_u (local.get $new_cap) (i32.const 8))
          (then (local.set $new_cap (i32.const 8))))
        (local.set $new_ptrs (call $heap_alloc (i32.shl (local.get $new_cap) (i32.const 2))))
        (local.set $new_ptrs_wa (call $g2w (local.get $new_ptrs)))
        (local.set $i (i32.const 0))
        (block $copy_done (loop $copy
          (br_if $copy_done (i32.ge_u (local.get $i) (local.get $count)))
          (i32.store
            (i32.add (local.get $new_ptrs_wa) (i32.shl (local.get $i) (i32.const 2)))
            (i32.load (i32.add (local.get $ptrs_wa) (i32.shl (local.get $i) (i32.const 2)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $copy)))
        (if (local.get $ptrs) (then (call $heap_free (local.get $ptrs))))
        (local.set $ptrs (local.get $new_ptrs))
        (local.set $ptrs_wa (local.get $new_ptrs_wa))
        (i32.store offset=4 (local.get $dpa_wa) (local.get $new_cap))
        (i32.store offset=8 (local.get $dpa_wa) (local.get $new_ptrs))))
    ;; Shift [idx, count) up one slot, walking down so the copy cannot
    ;; overwrite a source it has not read yet.
    (local.set $i (local.get $count))
    (block $shift_done (loop $shift
      (br_if $shift_done (i32.le_u (local.get $i) (local.get $idx)))
      (i32.store
        (i32.add (local.get $ptrs_wa) (i32.shl (local.get $i) (i32.const 2)))
        (i32.load (i32.add (local.get $ptrs_wa)
          (i32.shl (i32.sub (local.get $i) (i32.const 1)) (i32.const 2)))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $shift)))
    (i32.store (i32.add (local.get $ptrs_wa) (i32.shl (local.get $idx) (i32.const 2)))
      (local.get $arg2))
    (i32.store (local.get $dpa_wa) (i32.add (local.get $count) (i32.const 1)))
    (global.set $eax (local.get $idx))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; DPA_DeletePtr(hdpa, index) — 2 args, returns removed pointer
  ;; Removing element N must close the gap. Only decrementing the count
  ;; drops the LAST element logically while leaving every index from N on
  ;; pointing at its old record — which is how Task Manager's End Task came
  ;; to post WM_CLOSE to a window belonging to an app that had already quit.
  (func $handle_DPA_DeletePtr (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $count i32)
    (local $ptrs i32)
    (local $removed i32)
    (local $i i32)
    (local $dpa_wa i32) (local $ptrs_wa i32)
    (local.set $dpa_wa (call $g2w (local.get $arg0)))
    (local.set $count (i32.load (local.get $dpa_wa)))
    (local.set $ptrs (i32.load offset=8 (local.get $dpa_wa)))
    (if (local.get $ptrs)
      (then (local.set $ptrs_wa (call $g2w (local.get $ptrs)))))
    (if (i32.lt_u (local.get $arg1) (local.get $count))
      (then
        (local.set $removed (i32.load (i32.add (local.get $ptrs_wa) (i32.shl (local.get $arg1) (i32.const 2)))))
        (local.set $i (local.get $arg1))
        (block $shift_done (loop $shift
          (br_if $shift_done (i32.ge_u (local.get $i) (i32.sub (local.get $count) (i32.const 1))))
          (i32.store
            (i32.add (local.get $ptrs_wa) (i32.shl (local.get $i) (i32.const 2)))
            (i32.load (i32.add (local.get $ptrs_wa)
              (i32.shl (i32.add (local.get $i) (i32.const 1)) (i32.const 2)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $shift)))
        (i32.store (local.get $dpa_wa) (i32.sub (local.get $count) (i32.const 1)))
        (global.set $eax (local.get $removed)))
      (else
        (global.set $eax (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; DPA_DeleteAllPtrs(hdpa) — 1 arg, returns BOOL
  (func $handle_DPA_DeleteAllPtrs (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Set count to 0
    (i32.store (call $g2w (local.get $arg0)) (i32.const 0))
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )
