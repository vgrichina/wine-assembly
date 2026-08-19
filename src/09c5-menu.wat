  ;; ============================================================
  ;; Menu painting + hit-testing (WAT-side, was JS drawMenuBar /
  ;; _drawDropdown / _drawAccelText / renderer-input menu hit code)
  ;; ============================================================
  ;; Menu data is heap-resident, owned by WAT, and indexed per window
  ;; via MENU_DATA_TABLE (parallel to WND_RECORDS slots). JS encodes a
  ;; flat blob from its parsed PE menu tree once when the menu is set,
  ;; passes it through $menu_set; we copy into the heap and remember
  ;; the pointer. Paint and hit-test then re-walk the blob on demand,
  ;; matching the way real USER32 walks an HMENU instead of caching
  ;; rectangles.
  ;;
  ;; Blob layout (see also MENU_DATA_TABLE comment in 01-header.wat):
  ;;   +0       i32  bar_count
  ;;   +4       bar_items[bar_count] × 16:
  ;;              +0  i32 text_offset  (offset in blob)
  ;;              +4  i32 text_len
  ;;              +8  i32 child_offset (offset to child header, 0 = none)
  ;;              +12 i32 id (0 for popup bar items; command id otherwise)
  ;;   <child header> per submenu:
  ;;     +0  i32 child_count
  ;;     +4  child_items[child_count] × 28:
  ;;              +0  i32 label_offset
  ;;              +4  i32 label_len
  ;;              +8  i32 shortcut_offset
  ;;              +12 i32 shortcut_len
  ;;              +16 i32 flags  (bit0 = separator, bit1 = grayed,
  ;;                               bit2 = checked, bit3 = popup)
  ;;              +20 i32 id
  ;;              +24 i32 child_offset (nested popup header, 0 if none)
  ;;   string bytes appended at the tail (referenced by *_offset above)
  ;;
  ;; Geometry constants — must match the old JS code so the layout is
  ;; pixel-identical:
  ;;   bar item height       = 18
  ;;   bar item left pad     = 4 (first item starts at x+4)
  ;;   bar item text inset   = 6 (text drawn at item.x+6)
  ;;   bar item width        = measureText(label) + 12
  ;;   dropdown width        = 180
  ;;   dropdown item height  = 20
  ;;   dropdown left/right pad = 2
  ;;   dropdown label inset  = 20 (from dropdown left)
  ;;   dropdown shortcut inset = 20 (from dropdown right)

  ;; --------- MENU_DATA_TABLE accessors ---------

  (func $menu_data_table_addr (param $slot i32) (result i32)
    (i32.add (global.get $MENU_DATA_TABLE) (i32.mul (local.get $slot) (i32.const 4))))

  ;; Returns the WASM linear address of this hwnd's menu blob, or 0.
  (func $menu_blob_w (param $hwnd i32) (result i32)
    (local $slot i32) (local $g i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $g (i32.load (call $menu_data_table_addr (local.get $slot))))
    (if (i32.eqz (local.get $g)) (then (return (i32.const 0))))
    (call $g2w (local.get $g)))

  ;; Persistent menu allocations carry a private two-dword header immediately
  ;; before the guest-visible blob: the original resource key at -8 and the
  ;; blob byte length at -4. Keeping the key lets GetMenu return an identity
  ;; that SetMenu can resolve again, including named menu resources. Dynamic
  ;; TrackPopupMenu blobs do not use this table.
  (func $menu_source_get (param $hwnd i32) (result i32)
    (local $slot i32) (local $g i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $g (i32.load (call $menu_data_table_addr (local.get $slot))))
    (if (i32.lt_u (local.get $g) (i32.const 8)) (then (return (i32.const 0))))
    (i32.load (call $g2w (i32.sub (local.get $g) (i32.const 8)))))

  (func $menu_blob_size (param $hwnd i32) (result i32)
    (local $slot i32) (local $g i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return (i32.const 0))))
    (local.set $g (i32.load (call $menu_data_table_addr (local.get $slot))))
    (if (i32.lt_u (local.get $g) (i32.const 4)) (then (return (i32.const 0))))
    (i32.load (call $g2w (i32.sub (local.get $g) (i32.const 4)))))

  ;; Dropdown helpers normally read the window's menu-bar blob. Dynamic popup
  ;; menus created with CreatePopupMenu/AppendMenuA do not belong to the menu
  ;; bar, so TrackPopupMenu synthesizes a transient one-popup blob and stores it
  ;; here for painting, hit-testing, and activation until $menu_close.
  (func $menu_dropdown_blob_w (param $hwnd i32) (result i32)
    (if (i32.and
          (i32.ne (global.get $menu_open_popup_blob) (i32.const 0))
          (i32.eq (local.get $hwnd) (global.get $menu_open_hwnd)))
      (then (return (call $g2w (global.get $menu_open_popup_blob)))))
    (call $menu_blob_w (local.get $hwnd)))

  ;; Dynamic popup HMENU state. Handles are guest heap pointers to:
  ;; +0 magic "MNUD", +4 count, +8 capacity, +12 reserved,
  ;; +16 items[capacity] where each item is { flags, id, itemData, reserved }.
  ;; This is intentionally small; WordPad's color popup appends 17 owner-draw
  ;; items and then lets USER32 drive TrackPopupMenu/WM_COMMAND selection.
  (func $dynamic_menu_state_w (param $hmenu i32) (result i32)
    (local $sw i32)
    (if (i32.or
          (i32.eqz (local.get $hmenu))
          (i32.or
            (i32.lt_u (local.get $hmenu) (global.get $heap_base))
            (i32.ge_u (local.get $hmenu) (global.get $heap_ptr))))
      (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $hmenu)))
    (if (i32.ne (i32.load (local.get $sw)) (i32.const 0x4D4E5544))
      (then (return (i32.const 0))))
    (local.get $sw))

  ;; Validate every HMENU representation used by the compatibility layer:
  ;; heap-backed popup menus, resource-backed LoadMenu handles, fixed handles
  ;; returned by GetMenu/GetSystemMenu, encoded submenu handles, and the small
  ;; host-owned range returned by CreateMenu.
  (func $menu_handle_is_valid (param $hmenu i32) (result i32)
    (if (i32.eqz (local.get $hmenu)) (then (return (i32.const 0))))
    (if (call $dynamic_menu_state_w (local.get $hmenu))
      (then (return (i32.const 1))))
    (if (i32.or
          (i32.eq (local.get $hmenu) (i32.const 0x00080001))
          (i32.eq (local.get $hmenu) (i32.const 0x00040003)))
      (then (return (i32.const 1))))
    (if (i32.eq
          (i32.and (local.get $hmenu) (i32.const 0x00FF0000))
          (i32.const 0x00BE0000))
      (then (return (i32.const 1))))
    (if (i32.and
          (i32.ge_u (local.get $hmenu) (i32.const 0x00800001))
          (i32.lt_u (local.get $hmenu) (i32.const 0x00900000)))
      (then (return (i32.const 1))))
    ;; GetSubMenu encodes its zero-based position+1 in the high word.
    (if (i32.and
          (i32.ne (i32.and (local.get $hmenu) (i32.const 0xFFFF0000)) (i32.const 0))
          (i32.ne (i32.and (local.get $hmenu) (i32.const 0x0000FFFF)) (i32.const 0)))
      (then (return (i32.const 1))))
    (i32.const 0))

  (func $dynamic_menu_create (result i32)
    (local $hmenu i32) (local $sw i32)
    ;; 64 entries is enough for Win9x color/font popup menus and keeps every
    ;; HMENU self-contained without a realloc path.
    (local.set $hmenu (call $heap_alloc (i32.const 1040))) ;; 16 + 64*16
    (if (i32.eqz (local.get $hmenu)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $hmenu)))
    (call $zero_memory (local.get $sw) (i32.const 1040))
    (i32.store        (local.get $sw) (i32.const 0x4D4E5544)) ;; "MNUD"
    (i32.store offset=8 (local.get $sw) (i32.const 64))
    (local.get $hmenu))

  ;; Returns -1 when $hmenu is not a WAT dynamic menu; otherwise TRUE/FALSE.
  (func $dynamic_menu_append
        (param $hmenu i32) (param $flags i32) (param $id i32) (param $itemData i32)
        (result i32)
    (local $sw i32) (local $count i32) (local $cap i32) (local $rec i32)
    (local.set $sw (call $dynamic_menu_state_w (local.get $hmenu)))
    (if (i32.eqz (local.get $sw)) (then (return (i32.const -1))))
    (local.set $count (i32.load offset=4 (local.get $sw)))
    (local.set $cap (i32.load offset=8 (local.get $sw)))
    (if (i32.ge_u (local.get $count) (local.get $cap))
      (then (return (i32.const 0))))
    (local.set $rec
      (i32.add (local.get $sw)
        (i32.add (i32.const 16) (i32.mul (local.get $count) (i32.const 16)))))
    (i32.store         (local.get $rec) (local.get $flags))
    (i32.store offset=4  (local.get $rec) (local.get $id))
    (i32.store offset=8  (local.get $rec) (local.get $itemData))
    (i32.store offset=12 (local.get $rec) (i32.const 0))
    (i32.store offset=4 (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
    (i32.const 1))

  ;; Position of the item carrying command id $id, or -1. InsertMenu and
  ;; InsertMenuItem both accept "insert before the item with this id" as an
  ;; alternative to a positional index.
  (func $dynamic_menu_index_of_id (param $sw i32) (param $id i32) (result i32)
    (local $i i32) (local $count i32) (local $rec i32)
    (local.set $count (i32.load offset=4 (local.get $sw)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $rec
        (i32.add (local.get $sw)
          (i32.add (i32.const 16) (i32.mul (local.get $i) (i32.const 16)))))
      (if (i32.eq (i32.load offset=4 (local.get $rec)) (local.get $id))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Insert an item *before* position $pos, shifting the tail down. A $pos at
  ;; or past the end appends, which is what Win32 does for InsertMenu with
  ;; MF_BYPOSITION and an out-of-range position. Returns -1 when $hmenu is not
  ;; a WAT dynamic menu; otherwise TRUE/FALSE.
  ;; $submenu lands in the record's fourth dword, which $dynamic_menu_append
  ;; leaves zero. A popup item carries both a label and a submenu handle and
  ;; itemData already holds the label, so the two cannot share one slot.
  (func $dynamic_menu_insert
        (param $hmenu i32) (param $pos i32) (param $flags i32) (param $id i32)
        (param $itemData i32) (param $submenu i32)
        (result i32)
    (local $sw i32) (local $count i32) (local $cap i32) (local $rec i32) (local $i i32)
    (local.set $sw (call $dynamic_menu_state_w (local.get $hmenu)))
    (if (i32.eqz (local.get $sw)) (then (return (i32.const -1))))
    (local.set $count (i32.load offset=4 (local.get $sw)))
    (local.set $cap (i32.load offset=8 (local.get $sw)))
    (if (i32.ge_u (local.get $count) (local.get $cap))
      (then (return (i32.const 0))))
    (if (i32.lt_s (local.get $pos) (i32.const 0))
      (then (local.set $pos (local.get $count))))
    (if (i32.gt_u (local.get $pos) (local.get $count))
      (then (local.set $pos (local.get $count))))
    ;; Shift from the tail back so overlapping records copy cleanly.
    (local.set $i (local.get $count))
    (block $done (loop $shift
      (br_if $done (i32.le_u (local.get $i) (local.get $pos)))
      (local.set $rec
        (i32.add (local.get $sw)
          (i32.add (i32.const 16) (i32.mul (local.get $i) (i32.const 16)))))
      (i32.store         (local.get $rec) (i32.load         (i32.sub (local.get $rec) (i32.const 16))))
      (i32.store offset=4  (local.get $rec) (i32.load offset=4  (i32.sub (local.get $rec) (i32.const 16))))
      (i32.store offset=8  (local.get $rec) (i32.load offset=8  (i32.sub (local.get $rec) (i32.const 16))))
      (i32.store offset=12 (local.get $rec) (i32.load offset=12 (i32.sub (local.get $rec) (i32.const 16))))
      (local.set $i (i32.sub (local.get $i) (i32.const 1)))
      (br $shift)))
    (local.set $rec
      (i32.add (local.get $sw)
        (i32.add (i32.const 16) (i32.mul (local.get $pos) (i32.const 16)))))
    (i32.store         (local.get $rec) (local.get $flags))
    (i32.store offset=4  (local.get $rec) (local.get $id))
    (i32.store offset=8  (local.get $rec) (local.get $itemData))
    (i32.store offset=12 (local.get $rec) (local.get $submenu))
    (i32.store offset=4 (local.get $sw) (i32.add (local.get $count) (i32.const 1)))
    (i32.const 1))

  ;; Resolve the InsertMenu/InsertMenuItem "uItem" argument to a position.
  ;; $by_position selects between a raw index and an item id.
  (func $dynamic_menu_resolve_pos
        (param $hmenu i32) (param $uItem i32) (param $by_position i32) (result i32)
    (local $sw i32)
    (local.set $sw (call $dynamic_menu_state_w (local.get $hmenu)))
    (if (i32.eqz (local.get $sw)) (then (return (i32.const -1))))
    (if (local.get $by_position) (then (return (local.get $uItem))))
    (call $dynamic_menu_index_of_id (local.get $sw) (local.get $uItem)))

  ;; Fold a MENUITEMINFO at guest address $mii into the (flags, id, itemData)
  ;; triple the dynamic menu stores. The MFT_*/MFS_* constants deliberately
  ;; share values with the MF_* ones AppendMenu uses, so the type and state
  ;; words carry straight across; only the string pointer needs picking out.
  ;; Returns the flags; $out_* are written through the two globals below to
  ;; keep the handler side free of multi-value plumbing.
  (global $mii_out_id (mut i32) (i32.const 0))
  (global $mii_out_data (mut i32) (i32.const 0))
  (global $mii_out_submenu (mut i32) (i32.const 0))
  (func $menu_item_info_decode (param $mii i32) (result i32)
    (local $mask i32) (local $flags i32)
    (global.set $mii_out_id (i32.const 0))
    (global.set $mii_out_data (i32.const 0))
    (global.set $mii_out_submenu (i32.const 0))
    (if (i32.eqz (local.get $mii)) (then (return (i32.const 0))))
    (local.set $mask (call $gl32 (i32.add (local.get $mii) (i32.const 4))))
    ;; MIIM_FTYPE (0x100) and the older MIIM_TYPE (0x10) both describe fType.
    (if (i32.and (local.get $mask) (i32.const 0x110))
      (then (local.set $flags (call $gl32 (i32.add (local.get $mii) (i32.const 8))))))
    ;; MIIM_STATE
    (if (i32.and (local.get $mask) (i32.const 0x1))
      (then (local.set $flags (i32.or (local.get $flags)
              (call $gl32 (i32.add (local.get $mii) (i32.const 12)))))))
    ;; MIIM_ID
    (if (i32.and (local.get $mask) (i32.const 0x2))
      (then (global.set $mii_out_id (call $gl32 (i32.add (local.get $mii) (i32.const 16))))))
    ;; MIIM_SUBMENU — a non-null handle makes this a popup item.
    (if (i32.and (local.get $mask) (i32.const 0x4))
      (then
        (if (call $gl32 (i32.add (local.get $mii) (i32.const 20)))
          (then
            (local.set $flags (i32.or (local.get $flags) (i32.const 0x10))) ;; MF_POPUP
            (global.set $mii_out_submenu (call $gl32 (i32.add (local.get $mii) (i32.const 20))))))))
    ;; MIIM_DATA — owner-draw payload.
    (if (i32.and (local.get $mask) (i32.const 0x20))
      (then (global.set $mii_out_data (call $gl32 (i32.add (local.get $mii) (i32.const 32))))))
    ;; MIIM_STRING / MIIM_TYPE with a string type: dwTypeData is the label.
    (if (i32.and (local.get $mask) (i32.const 0x50))
      (then
        (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x900))) ;; not separator/owner-draw
          (then (global.set $mii_out_data (call $gl32 (i32.add (local.get $mii) (i32.const 36))))))))
    (local.get $flags))

  (func $dynamic_menu_destroy (param $hmenu i32) (result i32)
    (local $sw i32)
    (local.set $sw (call $dynamic_menu_state_w (local.get $hmenu)))
    (if (i32.eqz (local.get $sw)) (then (return (i32.const 0))))
    (call $heap_free (local.get $hmenu))
    (i32.const 1))

  (func $hex_ascii (param $n i32) (result i32)
    (local.set $n (i32.and (local.get $n) (i32.const 0x0F)))
    (if (i32.lt_u (local.get $n) (i32.const 10))
      (then (return (i32.add (local.get $n) (i32.const 48)))))
    (i32.add (local.get $n) (i32.const 87)))

  (func $write_hex_menu_label (param $dst i32) (param $id i32)
    (i32.store8        (local.get $dst) (i32.const 35)) ;; '#'
    (i32.store8 offset=1 (local.get $dst)
      (call $hex_ascii (i32.shr_u (local.get $id) (i32.const 12))))
    (i32.store8 offset=2 (local.get $dst)
      (call $hex_ascii (i32.shr_u (local.get $id) (i32.const 8))))
    (i32.store8 offset=3 (local.get $dst)
      (call $hex_ascii (i32.shr_u (local.get $id) (i32.const 4))))
    (i32.store8 offset=4 (local.get $dst)
      (call $hex_ascii (local.get $id))))

  ;; Label bytes for one dynamic item, or 0 when the item has no string of its
  ;; own: MF_SEPARATOR (0x800) draws a line, and MF_BITMAP (0x04) /
  ;; MF_OWNERDRAW (0x100) make lpNewItem a handle rather than text.
  (func $dynamic_item_label_w (param $item_w i32) (result i32)
    (local $data i32)
    (if (i32.and (i32.load (local.get $item_w)) (i32.const 0x904))
      (then (return (i32.const 0))))
    (local.set $data (i32.load offset=8 (local.get $item_w)))
    (if (i32.eqz (local.get $data)) (then (return (i32.const 0))))
    (call $g2w (local.get $data)))

  ;; First '\t' in an ASCII run, or -1. ($ml_find_tab is for the UTF-16
  ;; characters a menu resource holds and cannot read these.)
  (func $dynamic_find_tab (param $wa i32) (param $len i32) (result i32)
    (local $i i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $wa) (local.get $i))) (i32.const 0x09))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  (func $dynamic_menu_make_popup_blob (param $hmenu i32) (result i32)
    (local $sw i32) (local $count i32) (local $total i32) (local $strings i32)
    (local $blob_g i32) (local $blob_w i32)
    (local $i i32) (local $item i32) (local $rec i32) (local $flags i32)
    (local $out_flags i32) (local $label_off i32) (local $id i32)
    (local $label i32) (local $chars i32) (local $tab i32)
    (local $label_chars i32) (local $sc_chars i32)
    (local.set $sw (call $dynamic_menu_state_w (local.get $hmenu)))
    (if (i32.eqz (local.get $sw)) (then (return (i32.const 0))))
    (local.set $count (i32.load offset=4 (local.get $sw)))
    (if (i32.eqz (local.get $count)) (then (return (i32.const 0))))
    ;; Pass 1 sizes the string region. Every item used to get a 5-byte "#hhhh"
    ;; rendering of its command id, and that is what the popup actually
    ;; painted -- a menu an app builds at runtime showed "#0065" where its
    ;; label belonged, and GetMenuString read the same thing back. The string
    ;; AppendMenu was handed is right there in the item record.
    (local.set $i (i32.const 0))
    (block $sized (loop $measure
      (br_if $sized (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $item
        (i32.add (local.get $sw)
          (i32.add (i32.const 16) (i32.mul (local.get $i) (i32.const 16)))))
      (local.set $label (call $dynamic_item_label_w (local.get $item)))
      ;; A tab-split label only shrinks (the '\t' itself is dropped), so the
      ;; raw length is a safe reservation for label + shortcut together.
      (local.set $strings
        (i32.add (local.get $strings)
          (if (result i32) (local.get $label)
            (then (call $strlen (local.get $label)))
            (else (i32.const 5)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $measure)))
    ;; 4 + one 16-byte bar record + 4 child count + N*28 records + the strings.
    (local.set $total
      (i32.add (i32.const 24)
        (i32.add (i32.mul (local.get $count) (i32.const 28))
                 (local.get $strings))))
    (local.set $blob_g (call $heap_alloc (local.get $total)))
    (if (i32.eqz (local.get $blob_g)) (then (return (i32.const 0))))
    (local.set $blob_w (call $g2w (local.get $blob_g)))
    (call $zero_memory (local.get $blob_w) (local.get $total))
    (i32.store         (local.get $blob_w) (i32.const 1))  ;; one synthetic top-level popup
    (i32.store offset=12 (local.get $blob_w) (i32.const 20)) ;; bar[0].child_offset
    (i32.store offset=20 (local.get $blob_w) (local.get $count))
    (local.set $label_off (i32.add (i32.const 24) (i32.mul (local.get $count) (i32.const 28))))
    (local.set $i (i32.const 0))
    (block $done (loop $items
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $item
        (i32.add (local.get $sw)
          (i32.add (i32.const 16) (i32.mul (local.get $i) (i32.const 16)))))
      (local.set $rec
        (i32.add (local.get $blob_w)
          (i32.add (i32.const 24) (i32.mul (local.get $i) (i32.const 28)))))
      (local.set $flags (i32.load (local.get $item)))
      (local.set $id (i32.load offset=4 (local.get $item)))
      (local.set $out_flags (i32.const 0))
      (if (i32.or (i32.and (local.get $flags) (i32.const 0x0800))
                  (i32.eqz (local.get $id)))
        (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 1)))))
      (if (i32.and (local.get $flags) (i32.const 0x0003))
        (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 2)))))
      (if (i32.and (local.get $flags) (i32.const 0x0008))
        (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 4)))))
      (i32.store offset=16 (local.get $rec) (local.get $out_flags))
      (i32.store offset=20 (local.get $rec) (local.get $id))
      (i32.store offset=24 (local.get $rec) (i32.const 0))
      (local.set $label (call $dynamic_item_label_w (local.get $item)))
      (if (local.get $label)
        (then
          (local.set $chars (call $strlen (local.get $label)))
          ;; Same split the resource loader does: everything after the first
          ;; '\t' is the right-aligned shortcut column, not part of the label.
          (local.set $tab (call $dynamic_find_tab (local.get $label) (local.get $chars)))
          (if (i32.ge_s (local.get $tab) (i32.const 0))
            (then
              (local.set $label_chars (local.get $tab))
              (local.set $sc_chars
                (i32.sub (i32.sub (local.get $chars) (local.get $tab)) (i32.const 1))))
            (else
              (local.set $label_chars (local.get $chars))
              (local.set $sc_chars (i32.const 0))))
          (i32.store         (local.get $rec) (local.get $label_off))
          (i32.store offset=4  (local.get $rec) (local.get $label_chars))
          (call $memcpy (i32.add (local.get $blob_w) (local.get $label_off))
                (local.get $label) (local.get $label_chars))
          (local.set $label_off (i32.add (local.get $label_off) (local.get $label_chars)))
          (if (local.get $sc_chars)
            (then
              (i32.store offset=8  (local.get $rec) (local.get $label_off))
              (i32.store offset=12 (local.get $rec) (local.get $sc_chars))
              (call $memcpy (i32.add (local.get $blob_w) (local.get $label_off))
                    (i32.add (local.get $label) (i32.add (local.get $tab) (i32.const 1)))
                    (local.get $sc_chars))
              (local.set $label_off
                (i32.add (local.get $label_off) (local.get $sc_chars))))))
        (else
          ;; No string of its own (separator, bitmap, owner-draw): keep the id
          ;; rendering, which separators ignore and owner-draw items overpaint.
          (i32.store         (local.get $rec) (local.get $label_off))
          (i32.store offset=4  (local.get $rec) (i32.const 5))
          (call $write_hex_menu_label
            (i32.add (local.get $blob_w) (local.get $label_off))
            (local.get $id))
          (local.set $label_off (i32.add (local.get $label_off) (i32.const 5)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $items)))
    (local.get $blob_g))

  ;; Install (or replace) a menu blob for a window. Allocates heap
  ;; memory, memcpys the source bytes, stores the guest pointer in
  ;; MENU_DATA_TABLE[slot]. Frees any prior blob first.
  ;; Args: hwnd, src_wa (WASM addr), len (bytes).
  (func (export "menu_set")
        (param $hwnd i32) (param $src_wa i32) (param $len i32)
    (local $slot i32) (local $tbl i32) (local $old i32) (local $newg i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $tbl (call $menu_data_table_addr (local.get $slot)))
    (local.set $old (i32.load (local.get $tbl)))
    (if (local.get $old)
      (then (call $heap_free (i32.sub (local.get $old) (i32.const 8)))))
    (i32.store (local.get $tbl) (i32.const 0))
    (if (i32.eqz (local.get $len)) (then (return)))
    (local.set $newg (call $heap_alloc (i32.add (local.get $len) (i32.const 8))))
    (i32.store (call $g2w (local.get $newg)) (i32.const 0))
    (i32.store offset=4 (call $g2w (local.get $newg)) (local.get $len))
    (call $memcpy
      (call $g2w (i32.add (local.get $newg) (i32.const 8)))
      (local.get $src_wa) (local.get $len))
    (i32.store (local.get $tbl) (i32.add (local.get $newg) (i32.const 8))))

  ;; Drop a window's menu (called from $host_destroy_window path).
  (func (export "menu_clear") (param $hwnd i32)
    (local $slot i32) (local $tbl i32) (local $old i32)
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $tbl (call $menu_data_table_addr (local.get $slot)))
    (local.set $old (i32.load (local.get $tbl)))
    (if (local.get $old)
      (then (call $heap_free (i32.sub (local.get $old) (i32.const 8)))))
    (i32.store (local.get $tbl) (i32.const 0)))

  ;; Top-level item count (0 if no menu). Helper for keyboard nav.
  (func $menu_bar_count (export "menu_bar_count") (param $hwnd i32) (result i32)
    (local $b i32)
    (local.set $b (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $b)) (then (return (i32.const 0))))
    (i32.load (local.get $b)))

  ;; ----- text-width measurement -----
  ;; gdi_draw_text with DT_CALCRECT(0x400)|DT_SINGLELINE(0x20)|DT_NOPREFIX(0x800)
  ;; = 0xC20 returns the natural width via the rect's right field.
  (func $measure_text (param $hdc i32) (param $text_wa i32) (param $len i32)
                       (result i32)
    (i32.store           (global.get $PAINT_SCRATCH) (i32.const 0))
    (i32.store offset=4  (global.get $PAINT_SCRATCH) (i32.const 0))
    (i32.store offset=8  (global.get $PAINT_SCRATCH) (i32.const 0))
    (i32.store offset=12 (global.get $PAINT_SCRATCH) (i32.const 0))
    (drop (call $host_gdi_draw_text (local.get $hdc)
            (local.get $text_wa) (local.get $len)
            (global.get $PAINT_SCRATCH)
            (i32.const 0xC20) (i32.const 0)))
    (i32.load offset=8 (global.get $PAINT_SCRATCH)))

  ;; ----- bar item geometry walker -----
  ;; Compute the width of bar item $idx (0-based). hdc must be set up
  ;; with the menu font already selected. Returns text-width + 12.
  (func $bar_item_width (param $blob_w i32) (param $hdc i32) (param $idx i32)
                          (result i32)
    (local $base i32) (local $text_w i32)
    (local.set $base (i32.add (local.get $blob_w)
                       (i32.add (i32.const 4) (i32.mul (local.get $idx) (i32.const 16)))))
    (local.set $text_w
      (call $measure_text (local.get $hdc)
        (i32.add (local.get $blob_w) (i32.load (local.get $base)))
        (i32.load offset=4 (local.get $base))))
    (i32.add (local.get $text_w) (i32.const 12)))

  ;; Compute the LEFT edge x-offset (relative to bar start) of bar item
  ;; $target. Walks items 0..target-1, summing widths.
  (func $bar_item_x (param $blob_w i32) (param $hdc i32) (param $target i32)
                      (result i32)
    (local $i i32) (local $x i32)
    (local.set $x (i32.const 4))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $target)))
      (local.set $x (i32.add (local.get $x)
                       (call $bar_item_width (local.get $blob_w) (local.get $hdc) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $x))

  ;; ============================================================
  ;; $menu_paint_bar — draw the menu bar at (x, y, w, 18). Mirrors
  ;; the old JS drawMenuBar layout exactly (item.x = running cursor,
  ;; item.w = textWidth + 12, label drawn at item.x + 6, highlight
  ;; covers full item rect when open). Called via _activeChildDraw
  ;; routing so gdi_* primitives composite at the screen position
  ;; the renderer chose.
  ;; ============================================================
  (func $menu_bar_screen_x (export "menu_bar_screen_x") (param $hwnd i32) (result i32)
    (i32.add (call $wnd_window_screen_x (local.get $hwnd)) (i32.const 3)))

  (func $menu_bar_screen_y (export "menu_bar_screen_y") (param $hwnd i32) (result i32)
    (local $style i32) (local $is_child i32) (local $has_caption i32)
    (local.set $style (call $wnd_get_style (local.get $hwnd)))
    (local.set $is_child
      (i32.ne (i32.and (local.get $style) (i32.const 0x40000000)) (i32.const 0)))
    (local.set $has_caption
      (i32.eq (i32.and (local.get $style) (i32.const 0x00C00000))
              (i32.const 0x00C00000)))
    (if
      (i32.and
        (i32.eqz (local.get $is_child))
        (i32.and
          (i32.ne (i32.and (local.get $style) (i32.const 0x00800000)) (i32.const 0))
          (i32.ne (i32.and (local.get $style) (i32.const 0x00080000)) (i32.const 0))))
      (then (local.set $has_caption (i32.const 1))))
    (i32.add
      (call $wnd_window_screen_y (local.get $hwnd))
      (i32.add
        (i32.const 3)
        (select (i32.const 19) (i32.const 0) (local.get $has_caption)))))

  (func $menu_bar_screen_h (export "menu_bar_screen_h") (result i32)
    (i32.const 18))

  (func (export "menu_paint_bar")
        (param $hwnd i32) (param $x i32) (param $y i32) (param $w i32)
        (param $open_idx i32)
        (result i32)  ;; bar height drawn (0 if no menu)
    (local $blob i32) (local $count i32) (local $i i32)
    (local $hdc i32) (local $cur_x i32) (local $iw i32)
    (local $base i32) (local $text_wa i32) (local $text_len i32)

    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $count (i32.load (local.get $blob)))
    (if (i32.eqz (local.get $count)) (then (return (i32.const 0))))
    (if (i32.and
          (i32.ne (global.get $menu_open_popup_blob) (i32.const 0))
          (i32.eq (local.get $hwnd) (global.get $menu_open_hwnd)))
      (then (local.set $open_idx (i32.const -1))))

    (local.set $hdc (call $host_alloc_window_dc (local.get $hwnd) (i32.const 2)))
    (if (i32.eqz (local.get $hdc)) (then (return (i32.const 0))))
    ;; Background fill (menuBg = LTGRAY = 0xC0C0C0 = LTGRAY_BRUSH 0x30011).
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $x) (local.get $y)
            (i32.add (local.get $x) (local.get $w))
            (i32.add (local.get $y) (i32.const 18))
            (i32.const 0x30011)))
    ;; Font + transparent bk (so highlight or face shows through).
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))

    (local.set $cur_x (i32.add (local.get $x) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $base (i32.add (local.get $blob)
                         (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 16)))))
      (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $base))))
      (local.set $text_len (i32.load offset=4 (local.get $base)))
      (local.set $iw (i32.add (call $measure_text (local.get $hdc)
                                 (local.get $text_wa) (local.get $text_len))
                              (i32.const 12)))
      ;; Highlight rectangle if this is the open menu.
      (if (i32.eq (local.get $i) (local.get $open_idx))
        (then
          (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (local.get $cur_x) (local.get $y)
                  (i32.add (local.get $cur_x) (local.get $iw))
                  (i32.add (local.get $y) (i32.const 18))
                  (i32.const 14))) ;; COLOR_HIGHLIGHT brush (navy)
          (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFFFFFF))))
        (else
          (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))))
      ;; Draw label (gdi_draw_text handles & accelerator underline now).
      (i32.store           (global.get $PAINT_SCRATCH)
                           (i32.add (local.get $cur_x) (i32.const 6)))
      (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $y))
      (i32.store offset=8  (global.get $PAINT_SCRATCH) (i32.const 0x7FFF))
      (i32.store offset=12 (global.get $PAINT_SCRATCH)
                           (i32.add (local.get $y) (i32.const 18)))
      ;; DT_LEFT(0)|DT_VCENTER(4)|DT_SINGLELINE(0x20) = 0x24
      (drop (call $host_gdi_draw_text (local.get $hdc)
              (local.get $text_wa) (local.get $text_len)
              (global.get $PAINT_SCRATCH)
              (i32.const 0x24) (i32.const 0)))
      (local.set $cur_x (i32.add (local.get $cur_x) (local.get $iw)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    ;; Bottom 1px shadow line (btnShadow 0x808080).
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $x) (i32.add (local.get $y) (i32.const 17))
            (i32.add (local.get $x) (local.get $w))
            (i32.add (local.get $y) (i32.const 18))
            (i32.const 0x30012))) ;; GRAY_BRUSH
    (drop (call $host_release_dc (local.get $hdc)))
    (i32.const 18))

  ;; ============================================================
  ;; $menu_hittest_bar — given a screen-relative click point and the
  ;; bar's left/top, return the index of the hit bar item, or -1.
  ;; ============================================================
  (func $menu_hittest_bar (export "menu_hittest_bar")
        (param $hwnd i32) (param $bar_x i32) (param $bar_y i32)
        (param $click_x i32) (param $click_y i32)
        (result i32)
    (local $blob i32) (local $count i32) (local $i i32)
    (local $hdc i32) (local $cur_x i32) (local $iw i32)
    (local $base i32) (local $text_wa i32) (local $text_len i32)

    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const -1))))
    (if (i32.lt_s (local.get $click_y) (local.get $bar_y))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_y) (i32.add (local.get $bar_y) (i32.const 18)))
      (then (return (i32.const -1))))
    (local.set $count (i32.load (local.get $blob)))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))

    (local.set $cur_x (i32.add (local.get $bar_x) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $base (i32.add (local.get $blob)
                         (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 16)))))
      (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $base))))
      (local.set $text_len (i32.load offset=4 (local.get $base)))
      (local.set $iw (i32.add (call $measure_text (local.get $hdc)
                                 (local.get $text_wa) (local.get $text_len))
                              (i32.const 12)))
      (if (i32.and (i32.ge_s (local.get $click_x) (local.get $cur_x))
                   (i32.lt_s (local.get $click_x)
                             (i32.add (local.get $cur_x) (local.get $iw))))
        (then (return (local.get $i))))
      (local.set $cur_x (i32.add (local.get $cur_x) (local.get $iw)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Returns x-offset (relative to bar_x) of bar item $idx — used by JS
  ;; to anchor the dropdown beneath the open menu.
  (func $menu_bar_item_x (export "menu_bar_item_x")
        (param $hwnd i32) (param $idx i32) (result i32)
    (local $blob i32) (local $hdc i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (call $bar_item_x (local.get $blob) (local.get $hdc) (local.get $idx)))

  ;; ----- child group (dropdown) helpers -----

  ;; Address (in blob_w) of the child header for top-level item $idx,
  ;; or 0 if there are no children.
  (func $child_hdr_w (param $blob_w i32) (param $idx i32) (result i32)
    (local $base i32) (local $cof i32)
    (local.set $base (i32.add (local.get $blob_w)
                       (i32.add (i32.const 4) (i32.mul (local.get $idx) (i32.const 16)))))
    (local.set $cof (i32.load offset=8 (local.get $base)))
    (if (i32.eqz (local.get $cof)) (then (return (i32.const 0))))
    (i32.add (local.get $blob_w) (local.get $cof)))

  ;; Number of children for bar item $idx (0 if none).
  (func $menu_child_count (export "menu_child_count")
        (param $hwnd i32) (param $idx i32) (result i32)
    (local $blob i32) (local $hdr i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $idx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (i32.load (local.get $hdr)))

  ;; Command id of a top-level bar item. Most Win98 menu bars use popups
  ;; here, but Spider's "Deal!" is a real command item with no dropdown.
  (func $menu_bar_id (export "menu_bar_id")
        (param $hwnd i32) (param $idx i32) (result i32)
    (local $blob i32) (local $count i32) (local $base i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $count (i32.load (local.get $blob)))
    (if (i32.ge_u (local.get $idx) (local.get $count)) (then (return (i32.const 0))))
    (local.set $base (i32.add (local.get $blob)
                       (i32.add (i32.const 4) (i32.mul (local.get $idx) (i32.const 16)))))
    (i32.load offset=12 (local.get $base)))

  ;; Address (in blob_w) of child item $cidx within top item $tidx, or 0.
  (func $child_item_w (param $blob_w i32) (param $tidx i32) (param $cidx i32)
                        (result i32)
    (local $hdr i32)
    (local.set $hdr (call $child_hdr_w (local.get $blob_w) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (i32.add (local.get $hdr)
             (i32.add (i32.const 4) (i32.mul (local.get $cidx) (i32.const 28)))))

  ;; Command id of child (top, child).
  (func $menu_child_id (export "menu_child_id")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=20 (local.get $it)))

  ;; Flags of child (bit0 separator, bit1 grayed, bit2 checked).
  (func $menu_child_flags (export "menu_child_flags")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=16 (local.get $it)))

  (func $menu_child_label_ptr (export "menu_child_label_ptr")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.add (local.get $blob) (i32.load (local.get $it))))

  (func $menu_child_label_len (export "menu_child_label_len")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=4 (local.get $it)))

  (func (export "menu_child_shortcut_ptr")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32) (local $off i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (local.set $off (i32.load offset=8 (local.get $it)))
    (if (i32.eqz (local.get $off)) (then (return (i32.const 0))))
    (i32.add (local.get $blob) (local.get $off)))

  (func (export "menu_child_shortcut_len")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=12 (local.get $it)))

  ;; Nested popup helpers for one cascading submenu level under a dropdown item.
  (func $child_sub_hdr_w (param $blob_w i32) (param $tidx i32) (param $cidx i32)
                         (result i32)
    (local $it i32) (local $off i32)
    (local.set $it (call $child_item_w (local.get $blob_w) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (local.set $off (i32.load offset=24 (local.get $it)))
    (if (i32.eqz (local.get $off)) (then (return (i32.const 0))))
    (i32.add (local.get $blob_w) (local.get $off)))

  (func $submenu_item_w (param $blob_w i32) (param $tidx i32)
                        (param $cidx i32) (param $sidx i32) (result i32)
    (local $hdr i32)
    (local.set $hdr (call $child_sub_hdr_w
                      (local.get $blob_w) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (i32.add (local.get $hdr)
             (i32.add (i32.const 4) (i32.mul (local.get $sidx) (i32.const 28)))))

  (func $menu_child_sub_count (export "menu_child_sub_count")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $hdr i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $hdr (call $child_sub_hdr_w
                      (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (i32.load (local.get $hdr)))

  (func $menu_subchild_id (export "menu_subchild_id")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (param $sidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $submenu_item_w
                     (local.get $blob) (local.get $tidx) (local.get $cidx) (local.get $sidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=20 (local.get $it)))

  (func $menu_subchild_flags (export "menu_subchild_flags")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (param $sidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $submenu_item_w
                     (local.get $blob) (local.get $tidx) (local.get $cidx) (local.get $sidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=16 (local.get $it)))

  (func (export "menu_subchild_label_ptr")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (param $sidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $submenu_item_w
                     (local.get $blob) (local.get $tidx) (local.get $cidx) (local.get $sidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.add (local.get $blob) (i32.load (local.get $it))))

  (func (export "menu_subchild_label_len")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (param $sidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $submenu_item_w
                     (local.get $blob) (local.get $tidx) (local.get $cidx) (local.get $sidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (i32.load offset=4 (local.get $it)))

  ;; Set/clear the "checked" flag bit (bit2, value 0x04) on every item in
  ;; one child header, recursing into cascading submenus. Returns the first
  ;; matched item's previous state (MF_CHECKED=8 or MF_UNCHECKED=0), or -1
  ;; if nothing matched.
  (func $menu_group_set_check
        (param $blob_w i32) (param $blob_size i32) (param $hdr i32)
        (param $id i32) (param $check i32)
        (result i32)
    (local $cc i32) (local $i i32) (local $it i32) (local $flags i32)
    (local $hdr_off i32) (local $child_off i32) (local $r i32) (local $prev i32)
    (local.set $prev (i32.const -1))
    (if (i32.lt_u (local.get $hdr) (local.get $blob_w))
      (then (return (local.get $prev))))
    (local.set $hdr_off (i32.sub (local.get $hdr) (local.get $blob_w)))
    (if (i32.or
          (i32.lt_u (local.get $blob_size) (i32.const 4))
          (i32.gt_u (local.get $hdr_off) (i32.sub (local.get $blob_size) (i32.const 4))))
      (then (return (local.get $prev))))
    (local.set $cc (i32.load (local.get $hdr)))
    (if (i32.gt_u (local.get $cc)
          (i32.div_u
            (i32.sub (i32.sub (local.get $blob_size) (local.get $hdr_off)) (i32.const 4))
            (i32.const 28)))
      (then (return (local.get $prev))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $cc)))
      (local.set $it (i32.add (local.get $hdr)
                       (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 28)))))
      (if (i32.eq (i32.load offset=20 (local.get $it)) (local.get $id))
        (then
          (local.set $flags (i32.load offset=16 (local.get $it)))
          (if (i32.eq (local.get $prev) (i32.const -1))
            (then
              (local.set $prev
                (select (i32.const 8) (i32.const 0)
                  (i32.ne (i32.and (local.get $flags) (i32.const 0x04)) (i32.const 0))))))
          (if (local.get $check)
            (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x04))))
            (else (local.set $flags (i32.and (local.get $flags) (i32.const -5)))))
          (i32.store offset=16 (local.get $it) (local.get $flags))))
      (local.set $child_off (i32.load offset=24 (local.get $it)))
      (if (i32.and
            (i32.ne (local.get $child_off) (i32.const 0))
            (i32.and
              (i32.lt_u (local.get $child_off) (local.get $blob_size))
              (i32.ge_u (i32.sub (local.get $blob_size) (local.get $child_off)) (i32.const 4))))
        (then
          (local.set $r
            (call $menu_group_set_check
              (local.get $blob_w)
              (local.get $blob_size)
              (i32.add (local.get $blob_w) (local.get $child_off))
              (local.get $id)
              (local.get $check)))
          (if (i32.and
                (i32.eq (local.get $prev) (i32.const -1))
                (i32.ne (local.get $r) (i32.const -1)))
            (then (local.set $prev (local.get $r))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $prev))

  ;; Set/clear the "checked" flag bit (bit2, value 0x04) on every child
  ;; item in this blob whose command id matches $id. Returns the item's
  ;; previous checked state (MF_CHECKED=8 or MF_UNCHECKED=0) for the
  ;; first match, or -1 if nothing matched.
  (func $menu_blob_set_check
        (param $blob_w i32) (param $blob_size i32)
        (param $id i32) (param $check i32) (result i32)
    (local $bar_count i32) (local $i i32) (local $bar_item i32)
    (local $hdr_off i32) (local $r i32) (local $prev i32)
    (local.set $prev (i32.const -1))
    (if (i32.lt_u (local.get $blob_size) (i32.const 4))
      (then (return (local.get $prev))))
    (local.set $bar_count (i32.load (local.get $blob_w)))
    (if (i32.gt_u (local.get $bar_count)
          (i32.div_u (i32.sub (local.get $blob_size) (i32.const 4)) (i32.const 16)))
      (then (return (local.get $prev))))
    (local.set $i (i32.const 0))
    (block $done (loop $bar
      (br_if $done (i32.ge_u (local.get $i) (local.get $bar_count)))
      (local.set $bar_item (i32.add (local.get $blob_w)
                             (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 16)))))
      (local.set $hdr_off (i32.load offset=8 (local.get $bar_item)))
      (if (local.get $hdr_off)
        (then
          (local.set $r
            (call $menu_group_set_check
              (local.get $blob_w)
              (local.get $blob_size)
              (i32.add (local.get $blob_w) (local.get $hdr_off))
              (local.get $id)
              (local.get $check)))
          (if (i32.and
                (i32.eq (local.get $prev) (i32.const -1))
                (i32.ne (local.get $r) (i32.const -1)))
            (then (local.set $prev (local.get $r))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $bar)))
    (local.get $prev))

  ;; Set/clear checked state by submenu position. GetSubMenu handles are
  ;; represented as menu-id | ((top-index+1)<<16), which makes the resource
  ;; submenu deterministic without a separate HMENU object table.
  ;; EnableMenuItem with MF_BYPOSITION. MFC addresses every item this way while
  ;; walking a popup -- it asks GetMenuItemID what is at position N and then
  ;; enables or greys position N -- so routing the whole API through the
  ;; by-command path meant those calls landed on whichever item happened to
  ;; have that number as its ID, or on nothing at all. Paint greys File > Send
  ;; as position 9 of the File popup; before this, nothing moved.
  (func $menu_enable_position_global (export "menu_enable_position_global")
        (param $hmenu i32) (param $pos i32) (param $disabled i32) (result i32)
    (local $i i32) (local $hwnd i32) (local $blob i32) (local $it i32)
    (local $tidx i32) (local $flags i32) (local $prev i32)
    (local.set $prev (i32.const -1))
    (local.set $tidx (i32.sub (i32.shr_u (local.get $hmenu) (i32.const 16)) (i32.const 1)))
    (if (i32.lt_s (local.get $tidx) (i32.const 0)) (then (return (local.get $prev))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
      (if (local.get $hwnd)
        (then
          (local.set $blob (call $menu_blob_w (local.get $hwnd)))
          (if (local.get $blob)
            (then
              (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $pos)))
              (if (local.get $it)
                (then
                  (local.set $flags (i32.load offset=16 (local.get $it)))
                  (if (i32.eq (local.get $prev) (i32.const -1))
                    (then (local.set $prev
                      (select (i32.const 1) (i32.const 0)
                        (i32.ne (i32.and (local.get $flags) (i32.const 2)) (i32.const 0))))))
                  (i32.store offset=16 (local.get $it)
                    (select (i32.or (local.get $flags) (i32.const 2))
                            (i32.and (local.get $flags) (i32.const -3))
                            (local.get $disabled)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $prev))

  (func $menu_check_position_global (export "menu_check_position_global")
        (param $hmenu i32) (param $pos i32) (param $check i32) (result i32)
    (local $i i32) (local $hwnd i32) (local $blob i32) (local $it i32)
    (local $tidx i32) (local $flags i32) (local $prev i32)
    (local.set $prev (i32.const -1))
    (local.set $tidx (i32.sub (i32.shr_u (local.get $hmenu) (i32.const 16)) (i32.const 1)))
    (if (i32.lt_s (local.get $tidx) (i32.const 0)) (then (return (local.get $prev))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
      (if (local.get $hwnd)
        (then
          (local.set $blob (call $menu_blob_w (local.get $hwnd)))
          (if (local.get $blob)
            (then
              (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $pos)))
              (if (local.get $it)
                (then
                  (local.set $flags (i32.load offset=16 (local.get $it)))
                  (if (i32.eq (local.get $prev) (i32.const -1))
                    (then (local.set $prev
                      (select (i32.const 8) (i32.const 0)
                        (i32.ne (i32.and (local.get $flags) (i32.const 4)) (i32.const 0)))))))
                  (i32.store offset=16 (local.get $it)
                    (select (i32.or (local.get $flags) (i32.const 4))
                            (i32.and (local.get $flags) (i32.const -5))
                            (local.get $check)))
                  (call $invalidate_hwnd (local.get $hwnd)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $prev))

  ;; Resource menu enable/disable state. Internal flag bit1 is rendered as
  ;; MF_GRAYED; return values use the public MF_GRAYED/MF_ENABLED constants.
  (func $menu_group_set_disabled
        (param $blob i32) (param $hdr i32) (param $id i32) (param $disabled i32)
        (result i32)
    (local $count i32) (local $i i32) (local $it i32) (local $flags i32)
    (local $ret i32)
    (local.set $ret (i32.const -1))
    (local.set $count (i32.load (local.get $hdr)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $it (i32.add (local.get $hdr)
        (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 28)))))
      (if (i32.eq (i32.load offset=20 (local.get $it)) (local.get $id))
        (then
          (local.set $flags (i32.load offset=16 (local.get $it)))
          (if (i32.eq (local.get $ret) (i32.const -1))
            (then (local.set $ret
              (select (i32.const 1) (i32.const 0)
                (i32.ne (i32.and (local.get $flags) (i32.const 2)) (i32.const 0)))))))
          (i32.store offset=16 (local.get $it)
            (select (i32.or (local.get $flags) (i32.const 2))
                    (i32.and (local.get $flags) (i32.const -3))
                    (local.get $disabled))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (return (local.get $ret))
    (unreachable))

  (func $menu_enable_item_global (export "menu_enable_item_global")
        (param $hmenu i32) (param $item i32) (param $flags i32) (result i32)
    (local $i i32) (local $hwnd i32) (local $blob i32) (local $bar_count i32)
    (local $bar i32) (local $hdr_off i32) (local $ret i32) (local $r i32)
    (local $disabled i32)
    (local.set $ret (i32.const -1))
    (local.set $disabled (i32.and (local.get $flags) (i32.const 3)))
    (block $done
      (loop $wins
        (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
        (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
        (if (local.get $hwnd)
          (then
            (local.set $blob (call $menu_blob_w (local.get $hwnd)))
            (if (local.get $blob)
              (then
                (local.set $bar_count (i32.load (local.get $blob)))
                (local.set $bar (i32.const 0))
                (block $bars_done
                  (loop $bars
                    (br_if $bars_done
                      (i32.ge_u (local.get $bar) (local.get $bar_count)))
                    (local.set $hdr_off
                      (i32.load offset=8
                        (i32.add (local.get $blob)
                          (i32.add (i32.const 4)
                            (i32.mul (local.get $bar) (i32.const 16))))))
                    (if (local.get $hdr_off)
                      (then
                        (local.set $r
                          (call $menu_group_set_disabled
                            (local.get $blob)
                            (i32.add (local.get $blob) (local.get $hdr_off))
                            (local.get $item) (local.get $disabled)))
                        (if (i32.and
                              (i32.eq (local.get $ret) (i32.const -1))
                              (i32.ne (local.get $r) (i32.const -1)))
                          (then (local.set $ret (local.get $r))))))
                    (local.set $bar
                      (i32.add (local.get $bar) (i32.const 1)))
                    (br $bars)))
                (if (i32.ne (local.get $ret) (i32.const -1))
                  (then (call $invalidate_hwnd (local.get $hwnd))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $wins)))
    (local.get $ret))

  ;; CheckMenuRadioItem by submenu position. Fake submenu handles encode
  ;; GetSubMenu(hMenu,nPos) as low-word | ((nPos+1)<<16), so $tidx is
  ;; high-word-1. Sets bit2 on the selected child item and clears it on
  ;; the rest of [first..last].
  (func $menu_blob_check_radio_pos
        (param $blob_w i32) (param $tidx i32)
        (param $first i32) (param $last i32) (param $check i32) (result i32)
    (local $bar_count i32) (local $bar_item i32) (local $hdr_off i32)
    (local $hdr i32) (local $cc i32) (local $i i32) (local $it i32)
    (local $flags i32) (local $lo i32) (local $hi i32)
    (local.set $bar_count (i32.load (local.get $blob_w)))
    (if (i32.ge_u (local.get $tidx) (local.get $bar_count)) (then (return (i32.const 0))))
    (local.set $bar_item (i32.add (local.get $blob_w)
                           (i32.add (i32.const 4) (i32.mul (local.get $tidx) (i32.const 16)))))
    (local.set $hdr_off (i32.load offset=8 (local.get $bar_item)))
    (if (i32.eqz (local.get $hdr_off)) (then (return (i32.const 0))))
    (local.set $hdr (i32.add (local.get $blob_w) (local.get $hdr_off)))
    (local.set $cc (i32.load (local.get $hdr)))
    (local.set $lo
      (select (local.get $first) (local.get $last)
        (i32.le_u (local.get $first) (local.get $last))))
    (local.set $hi
      (select (local.get $last) (local.get $first)
        (i32.le_u (local.get $first) (local.get $last))))
    (local.set $i (local.get $lo))
    (block $done (loop $scan
      (br_if $done (i32.gt_u (local.get $i) (local.get $hi)))
      (br_if $done (i32.ge_u (local.get $i) (local.get $cc)))
      (local.set $it (i32.add (local.get $hdr)
                       (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 28)))))
      (local.set $flags (i32.load offset=16 (local.get $it)))
      (if (i32.eq (local.get $i) (local.get $check))
        (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x04))))
        (else (local.set $flags (i32.and (local.get $flags) (i32.const -5)))))
      (i32.store offset=16 (local.get $it) (local.get $flags))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 1))

  (func $menu_group_check_radio_cmd
        (param $blob_w i32) (param $hdr i32)
        (param $lo i32) (param $hi i32) (param $check i32) (result i32)
    (local $cc i32) (local $i i32) (local $it i32) (local $flags i32)
    (local $id i32) (local $child_off i32) (local $changed i32)
    (local.set $cc (i32.load (local.get $hdr)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $cc)))
      (local.set $it (i32.add (local.get $hdr)
                       (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 28)))))
      (local.set $id (i32.load offset=20 (local.get $it)))
      (if (i32.and (i32.ge_u (local.get $id) (local.get $lo))
                   (i32.le_u (local.get $id) (local.get $hi)))
        (then
          (local.set $flags (i32.load offset=16 (local.get $it)))
          (if (i32.eq (local.get $id) (local.get $check))
            (then (local.set $flags (i32.or (local.get $flags) (i32.const 0x04))))
            (else (local.set $flags (i32.and (local.get $flags) (i32.const -5)))))
          (i32.store offset=16 (local.get $it) (local.get $flags))
          (local.set $changed (i32.const 1))))
      (local.set $child_off (i32.load offset=24 (local.get $it)))
      (if (local.get $child_off)
        (then
          (if (call $menu_group_check_radio_cmd
                (local.get $blob_w)
                (i32.add (local.get $blob_w) (local.get $child_off))
                (local.get $lo) (local.get $hi) (local.get $check))
            (then (local.set $changed (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (local.get $changed))

  ;; CheckMenuRadioItem by command id. Clears every command id in the
  ;; requested range and checks idCheck, including nested cascading submenus.
  (func $menu_blob_check_radio_cmd
        (param $blob_w i32) (param $first i32) (param $last i32) (param $check i32) (result i32)
    (local $bar_count i32) (local $i i32) (local $bar_item i32)
    (local $hdr_off i32) (local $lo i32) (local $hi i32)
    (local $changed i32)
    (local.set $lo
      (select (local.get $first) (local.get $last)
        (i32.le_u (local.get $first) (local.get $last))))
    (local.set $hi
      (select (local.get $last) (local.get $first)
        (i32.le_u (local.get $first) (local.get $last))))
    (local.set $bar_count (i32.load (local.get $blob_w)))
    (local.set $i (i32.const 0))
    (block $done (loop $bar
      (br_if $done (i32.ge_u (local.get $i) (local.get $bar_count)))
      (local.set $bar_item (i32.add (local.get $blob_w)
                             (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 16)))))
      (local.set $hdr_off (i32.load offset=8 (local.get $bar_item)))
      (if (local.get $hdr_off)
        (then
          (if (call $menu_group_check_radio_cmd
                (local.get $blob_w)
                (i32.add (local.get $blob_w) (local.get $hdr_off))
                (local.get $lo) (local.get $hi) (local.get $check))
            (then (local.set $changed (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $bar)))
    (local.get $changed))

  (func $menu_check_radio_global (export "menu_check_radio_global")
        (param $hmenu i32) (param $first i32) (param $last i32)
        (param $check i32) (param $flags i32) (result i32)
    (local $i i32) (local $hwnd i32) (local $blob_w i32)
    (local $tidx i32) (local $changed i32)
    (local.set $tidx (i32.sub (i32.shr_u (local.get $hmenu) (i32.const 16)) (i32.const 1)))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
      (if (local.get $hwnd)
        (then
          (local.set $blob_w (call $menu_blob_w (local.get $hwnd)))
          (if (local.get $blob_w)
            (then
              (if (i32.and (local.get $flags) (i32.const 0x400)) ;; MF_BYPOSITION
                (then
                  (if (call $menu_blob_check_radio_pos
                        (local.get $blob_w) (local.get $tidx)
                        (local.get $first) (local.get $last) (local.get $check))
                    (then (local.set $changed (i32.const 1)))))
                (else
                  (if (call $menu_blob_check_radio_cmd
                        (local.get $blob_w)
                        (local.get $first) (local.get $last) (local.get $check))
                    (then (local.set $changed (i32.const 1))))))
              (if (local.get $changed)
                (then (call $invalidate_hwnd (local.get $hwnd))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (select (i32.const 1) (i32.const 0) (local.get $changed)))

  ;; Walk every window that has a menu blob and toggle the check state
  ;; of the first matching id. Invalidates any hwnd whose menu changed
  ;; so the next dropdown paint reflects the new state. Returns the
  ;; original state (MF_UNCHECKED=0, MF_CHECKED=8) or -1 if no match.
  (func $menu_check_item_global (export "menu_check_item_global")
        (param $id i32) (param $check i32) (result i32)
    (local $i i32) (local $hwnd i32) (local $blob_w i32) (local $blob_size i32)
    (local $r i32) (local $prev i32)
    (local.set $prev (i32.const -1))
    (local.set $i (i32.const 0))
    (block $done (loop $loop
      (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
      (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
      (if (local.get $hwnd)
        (then
          (local.set $blob_w (call $menu_blob_w (local.get $hwnd)))
          (if (local.get $blob_w)
            (then
              (local.set $blob_size (call $menu_blob_size (local.get $hwnd)))
              (local.set $r (call $menu_blob_set_check
                              (local.get $blob_w) (local.get $blob_size)
                              (local.get $id) (local.get $check)))
              (if (i32.ne (local.get $r) (i32.const -1))
                (then
                  (if (i32.eq (local.get $prev) (i32.const -1))
                    (then (local.set $prev (local.get $r))))
                  (call $invalidate_hwnd (local.get $hwnd))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $loop)))
    (local.get $prev))

  ;; Accel-char (uppercase ASCII) for top-level item $idx, or 0 if none.
  ;; The accel char is the byte after the first un-doubled '&'.
  (func $menu_bar_accel (export "menu_bar_accel")
        (param $hwnd i32) (param $idx i32) (result i32)
    (local $blob i32) (local $base i32)
    (local $text_wa i32) (local $text_len i32) (local $i i32) (local $ch i32)
    (local.set $blob (call $menu_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $base (i32.add (local.get $blob)
                       (i32.add (i32.const 4) (i32.mul (local.get $idx) (i32.const 16)))))
    (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $base))))
    (local.set $text_len (i32.load offset=4 (local.get $base)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (i32.add (local.get $i) (i32.const 1))
                             (local.get $text_len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $text_wa) (local.get $i))) (i32.const 0x26))
        (then
          (local.set $ch (i32.load8_u (i32.add (local.get $text_wa)
                            (i32.add (local.get $i) (i32.const 1)))))
          (if (i32.ne (local.get $ch) (i32.const 0x26))
            (then
              ;; Uppercase ASCII a-z → A-Z
              (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                           (i32.le_u (local.get $ch) (i32.const 0x7A)))
                (then (local.set $ch (i32.sub (local.get $ch) (i32.const 0x20)))))
              (return (local.get $ch)))
            ;; "&&" is a literal ampersand, so step over BOTH of them. Stepping
            ;; one at a time re-reads the second '&' as a fresh marker and
            ;; hands back whatever follows it — "Save && Exit" mnemonic'd on
            ;; the space, and it shadowed any real '&' later in the label.
            (else (local.set $i (i32.add (local.get $i) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Accel-char for child item (top, child) — same logic as bar_accel.
  (func $menu_child_accel (export "menu_child_accel")
        (param $hwnd i32) (param $tidx i32) (param $cidx i32) (result i32)
    (local $blob i32) (local $it i32)
    (local $text_wa i32) (local $text_len i32) (local $i i32) (local $ch i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $it (call $child_item_w (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $it)) (then (return (i32.const 0))))
    (local.set $text_wa (i32.add (local.get $blob) (i32.load (local.get $it))))
    (local.set $text_len (i32.load offset=4 (local.get $it)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (i32.add (local.get $i) (i32.const 1))
                             (local.get $text_len)))
      (if (i32.eq (i32.load8_u (i32.add (local.get $text_wa) (local.get $i))) (i32.const 0x26))
        (then
          (local.set $ch (i32.load8_u (i32.add (local.get $text_wa)
                            (i32.add (local.get $i) (i32.const 1)))))
          (if (i32.ne (local.get $ch) (i32.const 0x26))
            (then
              (if (i32.and (i32.ge_u (local.get $ch) (i32.const 0x61))
                           (i32.le_u (local.get $ch) (i32.const 0x7A)))
                (then (local.set $ch (i32.sub (local.get $ch) (i32.const 0x20)))))
              (return (local.get $ch)))
            ;; See $menu_bar_accel: skip both halves of a doubled ampersand.
            (else (local.set $i (i32.add (local.get $i) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $menu_draw_submenu_arrow (param $hdc i32) (param $dx i32)
                                 (param $iy i32) (param $hover i32)
    (i32.store8 (i32.add (global.get $PAINT_SCRATCH) (i32.const 16)) (i32.const 0x3E))
    (drop (call $host_gdi_set_text_color (local.get $hdc)
            (if (result i32) (local.get $hover)
              (then (i32.const 0xFFFFFF))
              (else (i32.const 0x000000)))))
    (i32.store           (global.get $PAINT_SCRATCH)
                         (i32.add (local.get $dx) (i32.const 164)))
    (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $iy))
    (i32.store offset=8  (global.get $PAINT_SCRATCH)
                         (i32.add (local.get $dx) (i32.const 176)))
    (i32.store offset=12 (global.get $PAINT_SCRATCH)
                         (i32.add (local.get $iy) (i32.const 20)))
    ;; DT_CENTER|DT_VCENTER|DT_SINGLELINE = 0x25
    (drop (call $host_gdi_draw_text (local.get $hdc)
            (i32.add (global.get $PAINT_SCRATCH) (i32.const 16)) (i32.const 1)
            (global.get $PAINT_SCRATCH)
            (i32.const 0x25) (i32.const 0))))

  (func $menu_draw_check_glyph (param $hdc i32) (param $dx i32)
                               (param $iy i32) (param $hover i32)
    (drop (call $host_gdi_select_object (local.get $hdc)
            (if (result i32) (local.get $hover)
              (then (i32.const 0x30016))   ;; WHITE_PEN on hover
              (else (i32.const 0x30017))))) ;; BLACK_PEN otherwise
    (drop (call $host_gdi_move_to (local.get $hdc)
            (i32.add (local.get $dx) (i32.const 5))
            (i32.add (local.get $iy) (i32.const 10))))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (i32.add (local.get $dx) (i32.const 8))
            (i32.add (local.get $iy) (i32.const 14))))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (i32.add (local.get $dx) (i32.const 14))
            (i32.add (local.get $iy) (i32.const 6))))
    (drop (call $host_gdi_move_to (local.get $hdc)
            (i32.add (local.get $dx) (i32.const 5))
            (i32.add (local.get $iy) (i32.const 11))))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (i32.add (local.get $dx) (i32.const 8))
            (i32.add (local.get $iy) (i32.const 15))))
    (drop (call $host_gdi_line_to (local.get $hdc)
            (i32.add (local.get $dx) (i32.const 14))
            (i32.add (local.get $iy) (i32.const 7))))
    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021))))

  ;; ============================================================
  ;; $menu_paint_dropdown — draw the dropdown for top-level item
  ;; $tidx at (dx, dy). Width is fixed at 180, height = count*20+4.
  ;; Items use itemH=20, label inset=20, hover highlight when
  ;; $hover_cidx == this child index.
  ;; ============================================================
  (func $menu_paint_submenu
        (param $hwnd i32) (param $tidx i32) (param $cidx i32)
        (param $dx i32) (param $dy i32) (param $hover_sidx i32)
    (local $blob i32) (local $hdr i32) (local $count i32) (local $i i32)
    (local $hdc i32) (local $iy i32) (local $it i32) (local $flags i32)
    (local $label_wa i32) (local $label_len i32)
    (local $sc_wa i32) (local $sc_len i32) (local $dh i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return)))
    (local.set $hdr (call $child_sub_hdr_w
                      (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $hdr)) (then (return)))
    (local.set $count (i32.load (local.get $hdr)))
    (if (i32.eqz (local.get $count)) (then (return)))

    (local.set $hdc (call $gdi_menu_overlay_ensure))
    (if (i32.eqz (local.get $hdc)) (then (return)))
    (local.set $dh (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (i32.const 180))
            (i32.add (local.get $dy) (local.get $dh))
            (i32.const 0x30011)))
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (i32.const 180))
            (i32.add (local.get $dy) (local.get $dh))
            (i32.const 0x05) (i32.const 0x0F)))

    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))

    (local.set $iy (i32.add (local.get $dy) (i32.const 2)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $it (i32.add (local.get $hdr)
                       (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 28)))))
      (local.set $flags (i32.load offset=16 (local.get $it)))
      (if (i32.and (local.get $flags) (i32.const 0x01))
        (then
          (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (i32.add (local.get $dx) (i32.const 4))
                  (i32.add (local.get $iy) (i32.const 9))
                  (i32.add (local.get $dx) (i32.const 176))
                  (i32.add (local.get $iy) (i32.const 10))
                  (i32.const 0x30012))))
        (else
          (if (i32.eq (local.get $i) (local.get $hover_sidx))
            (then
              (drop (call $host_gdi_fill_rect (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 2)) (local.get $iy)
                      (i32.add (local.get $dx) (i32.const 178))
                      (i32.add (local.get $iy) (i32.const 20))
                      (i32.const 14)))
              (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFFFFFF))))
            (else
              (if (i32.and (local.get $flags) (i32.const 0x02))
                (then (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x808080))))
                (else (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))))))
          (local.set $label_wa (i32.add (local.get $blob) (i32.load (local.get $it))))
          (local.set $label_len (i32.load offset=4 (local.get $it)))
          (if (i32.and (local.get $flags) (i32.const 0x04))
            (then
              (call $menu_draw_check_glyph
                (local.get $hdc) (local.get $dx) (local.get $iy)
                (i32.eq (local.get $i) (local.get $hover_sidx)))))
          (i32.store           (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $dx) (i32.const 20)))
          (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $iy))
          (i32.store offset=8  (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $dx) (i32.const 160)))
          (i32.store offset=12 (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $iy) (i32.const 20)))
          (drop (call $host_gdi_draw_text (local.get $hdc)
                  (local.get $label_wa) (local.get $label_len)
                  (global.get $PAINT_SCRATCH)
                  (i32.const 0x24) (i32.const 0)))
          (local.set $sc_len (i32.load offset=12 (local.get $it)))
          (if (local.get $sc_len)
            (then
              (local.set $sc_wa (i32.add (local.get $blob)
                                  (i32.load offset=8 (local.get $it))))
              (i32.store           (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $dx) (i32.const 20)))
              (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $iy))
              (i32.store offset=8  (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $dx) (i32.const 160)))
              (i32.store offset=12 (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $iy) (i32.const 20)))
              (drop (call $host_gdi_draw_text (local.get $hdc)
                      (local.get $sc_wa) (local.get $sc_len)
                      (global.get $PAINT_SCRATCH)
                      (i32.const 0x26) (i32.const 0)))))
          (if (i32.load offset=24 (local.get $it))
            (then
              (call $menu_draw_submenu_arrow
                (local.get $hdc) (local.get $dx) (local.get $iy)
                (i32.eq (local.get $i) (local.get $hover_sidx)))))))
      (local.set $iy (i32.add (local.get $iy) (i32.const 20)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan))))

  (func (export "menu_paint_dropdown")
        (param $hwnd i32) (param $tidx i32) (param $dx i32) (param $dy i32)
        (param $hover_cidx i32)
    (local $blob i32) (local $hdr i32) (local $count i32) (local $i i32)
    (local $hdc i32) (local $iy i32) (local $it i32) (local $flags i32)
    (local $label_wa i32) (local $label_len i32)
    (local $sc_wa i32) (local $sc_len i32) (local $dh i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return)))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return)))
    (local.set $count (i32.load (local.get $hdr)))
    (if (i32.eqz (local.get $count)) (then (return)))

    (local.set $hdc (call $gdi_menu_overlay_ensure))
    (if (i32.eqz (local.get $hdc)) (then (return)))
    (local.set $dh (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))
    ;; Background + outset border.
    (drop (call $host_gdi_fill_rect (local.get $hdc)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (i32.const 180))
            (i32.add (local.get $dy) (local.get $dh))
            (i32.const 0x30011)))
    (drop (call $host_gdi_draw_edge (local.get $hdc)
            (local.get $dx) (local.get $dy)
            (i32.add (local.get $dx) (i32.const 180))
            (i32.add (local.get $dy) (local.get $dh))
            (i32.const 0x05) (i32.const 0x0F)))

    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))

    (local.set $iy (i32.add (local.get $dy) (i32.const 2)))
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $it (i32.add (local.get $hdr)
                       (i32.add (i32.const 4) (i32.mul (local.get $i) (i32.const 28)))))
      (local.set $flags (i32.load offset=16 (local.get $it)))
      (if (i32.and (local.get $flags) (i32.const 0x01))
        (then
          ;; Separator: 1px shadow line in the middle of the row.
          (drop (call $host_gdi_fill_rect (local.get $hdc)
                  (i32.add (local.get $dx) (i32.const 4))
                  (i32.add (local.get $iy) (i32.const 9))
                  (i32.add (local.get $dx) (i32.const 176))
                  (i32.add (local.get $iy) (i32.const 10))
                  (i32.const 0x30012))))
        (else
          ;; Hover highlight.
          (if (i32.eq (local.get $i) (local.get $hover_cidx))
            (then
              (drop (call $host_gdi_fill_rect (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 2)) (local.get $iy)
                      (i32.add (local.get $dx) (i32.const 178))
                      (i32.add (local.get $iy) (i32.const 20))
                      (i32.const 14))) ;; COLOR_HIGHLIGHT brush
              (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0xFFFFFF))))
            (else
              (if (i32.and (local.get $flags) (i32.const 0x02))
                (then (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x808080))))
                (else (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x000000)))))))
          ;; Check glyph — two-stroke V drawn with BLACK_PEN/WHITE_PEN in the
          ;; left margin when MF_CHECKED (bit2) is set. Second pass offset by
          ;; +1 row gives a 2-px thick check. Font is re-selected after so
          ;; DrawText below keeps working.
          (if (i32.and (local.get $flags) (i32.const 0x04))
            (then
              (drop (call $host_gdi_select_object (local.get $hdc)
                      (if (result i32) (i32.eq (local.get $i) (local.get $hover_cidx))
                        (then (i32.const 0x30016))   ;; WHITE_PEN on hover
                        (else (i32.const 0x30017))))) ;; BLACK_PEN otherwise
              (drop (call $host_gdi_move_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 5))
                      (i32.add (local.get $iy) (i32.const 10))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 8))
                      (i32.add (local.get $iy) (i32.const 14))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 14))
                      (i32.add (local.get $iy) (i32.const 6))))
              (drop (call $host_gdi_move_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 5))
                      (i32.add (local.get $iy) (i32.const 11))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 8))
                      (i32.add (local.get $iy) (i32.const 15))))
              (drop (call $host_gdi_line_to (local.get $hdc)
                      (i32.add (local.get $dx) (i32.const 14))
                      (i32.add (local.get $iy) (i32.const 7))))
              (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))))
          ;; Label
          (local.set $label_wa (i32.add (local.get $blob) (i32.load (local.get $it))))
          (local.set $label_len (i32.load offset=4 (local.get $it)))
          (i32.store           (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $dx) (i32.const 20)))
          (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $iy))
          (i32.store offset=8  (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $dx) (i32.const 160)))
          (i32.store offset=12 (global.get $PAINT_SCRATCH)
                               (i32.add (local.get $iy) (i32.const 20)))
          ;; DT_LEFT|DT_VCENTER|DT_SINGLELINE = 0x24
          (drop (call $host_gdi_draw_text (local.get $hdc)
                  (local.get $label_wa) (local.get $label_len)
                  (global.get $PAINT_SCRATCH)
                  (i32.const 0x24) (i32.const 0)))
          ;; Optional shortcut, right-aligned.
          (local.set $sc_len (i32.load offset=12 (local.get $it)))
          (if (local.get $sc_len)
            (then
              (local.set $sc_wa (i32.add (local.get $blob)
                                  (i32.load offset=8 (local.get $it))))
              (i32.store           (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $dx) (i32.const 20)))
              (i32.store offset=4  (global.get $PAINT_SCRATCH) (local.get $iy))
              (i32.store offset=8  (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $dx) (i32.const 160)))
              (i32.store offset=12 (global.get $PAINT_SCRATCH)
                                   (i32.add (local.get $iy) (i32.const 20)))
              ;; DT_RIGHT(2)|DT_VCENTER(4)|DT_SINGLELINE(0x20) = 0x26
              (drop (call $host_gdi_draw_text (local.get $hdc)
                      (local.get $sc_wa) (local.get $sc_len)
                      (global.get $PAINT_SCRATCH)
                      (i32.const 0x26) (i32.const 0)))))
          (if (i32.load offset=24 (local.get $it))
            (then
              (call $menu_draw_submenu_arrow
                (local.get $hdc) (local.get $dx) (local.get $iy)
                (i32.eq (local.get $i) (local.get $hover_cidx)))))))
      (local.set $iy (i32.add (local.get $iy) (i32.const 20)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.and (i32.ge_s (local.get $hover_cidx) (i32.const 0))
                 (i32.lt_s (local.get $hover_cidx) (local.get $count)))
      (then
        (call $menu_paint_submenu
          (local.get $hwnd) (local.get $tidx) (local.get $hover_cidx)
          (i32.add (local.get $dx) (i32.const 180))
          (i32.add (i32.add (local.get $dy) (i32.const 2))
                   (i32.mul (local.get $hover_cidx) (i32.const 20)))
          (global.get $menu_open_sub_hover)))))

  ;; Let the compositor obtain/clear the presentation canvas before invoking
  ;; menu_paint_dropdown. The returned surface remains an ordinary WAT bitmap.
  (func (export "menu_prepare_overlay") (result i32)
    (i32.ne (call $gdi_menu_overlay_ensure) (i32.const 0)))

  ;; Dropdown box height for top item $tidx (0 if no children).
  ;; Used by JS to size the dropdown rect for hit-testing.
  (func (export "menu_dropdown_height")
        (param $hwnd i32) (param $tidx i32) (result i32)
    (local $blob i32) (local $hdr i32) (local $count i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const 0))))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const 0))))
    (local.set $count (i32.load (local.get $hdr)))
    (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))

  ;; Hit-test a click against an open dropdown of $tidx anchored at
  ;; (dx, dy). Returns child index, or -1 if outside / on a separator.
  (func $menu_hittest_dropdown (export "menu_hittest_dropdown")
        (param $hwnd i32) (param $tidx i32) (param $dx i32) (param $dy i32)
        (param $click_x i32) (param $click_y i32) (result i32)
    (local $blob i32) (local $hdr i32) (local $count i32) (local $cidx i32)
    (local $iy0 i32) (local $it i32) (local $flags i32) (local $dh i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const -1))))
    (local.set $hdr (call $child_hdr_w (local.get $blob) (local.get $tidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const -1))))
    (local.set $count (i32.load (local.get $hdr)))
    (local.set $dh (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))
    ;; Outside box?
    (if (i32.lt_s (local.get $click_x) (i32.add (local.get $dx) (i32.const 2)))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_x) (i32.add (local.get $dx) (i32.const 178)))
      (then (return (i32.const -1))))
    (if (i32.lt_s (local.get $click_y) (i32.add (local.get $dy) (i32.const 2)))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_y) (i32.add (local.get $dy) (local.get $dh)))
      (then (return (i32.const -1))))
    (local.set $iy0 (i32.add (local.get $dy) (i32.const 2)))
    (local.set $cidx (i32.div_s (i32.sub (local.get $click_y) (local.get $iy0))
                                 (i32.const 20)))
    (if (i32.lt_s (local.get $cidx) (i32.const 0)) (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $cidx) (local.get $count)) (then (return (i32.const -1))))
    (local.set $it (i32.add (local.get $hdr)
                     (i32.add (i32.const 4) (i32.mul (local.get $cidx) (i32.const 28)))))
    (local.set $flags (i32.load offset=16 (local.get $it)))
    (if (i32.and (local.get $flags) (i32.const 0x01))
      (then (return (i32.const -1))))
    (local.get $cidx))

  (func $menu_hittest_submenu
        (param $hwnd i32) (param $tidx i32) (param $cidx i32)
        (param $dx i32) (param $dy i32)
        (param $click_x i32) (param $click_y i32) (result i32)
    (local $blob i32) (local $hdr i32) (local $count i32) (local $sidx i32)
    (local $iy0 i32) (local $it i32) (local $flags i32) (local $dh i32)
    (local.set $blob (call $menu_dropdown_blob_w (local.get $hwnd)))
    (if (i32.eqz (local.get $blob)) (then (return (i32.const -1))))
    (local.set $hdr (call $child_sub_hdr_w
                      (local.get $blob) (local.get $tidx) (local.get $cidx)))
    (if (i32.eqz (local.get $hdr)) (then (return (i32.const -1))))
    (local.set $count (i32.load (local.get $hdr)))
    (local.set $dh (i32.add (i32.mul (local.get $count) (i32.const 20)) (i32.const 4)))
    ;; The box's own 2px border counts as inside. It used not to, and the left
    ;; border is precisely the column the pointer crosses when it slides right
    ;; out of the parent item: entering a cascade at its first two columns
    ;; highlighted nothing, so "Select Players > 2 Players" needed the pointer
    ;; to land two pixels deeper than the submenu appears to start.
    (if (i32.lt_s (local.get $click_x) (local.get $dx))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_x) (i32.add (local.get $dx) (i32.const 180)))
      (then (return (i32.const -1))))
    (if (i32.lt_s (local.get $click_y) (i32.add (local.get $dy) (i32.const 2)))
      (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $click_y) (i32.add (local.get $dy) (local.get $dh)))
      (then (return (i32.const -1))))
    (local.set $iy0 (i32.add (local.get $dy) (i32.const 2)))
    (local.set $sidx (i32.div_s (i32.sub (local.get $click_y) (local.get $iy0))
                                 (i32.const 20)))
    (if (i32.lt_s (local.get $sidx) (i32.const 0)) (then (return (i32.const -1))))
    (if (i32.ge_s (local.get $sidx) (local.get $count)) (then (return (i32.const -1))))
    (local.set $it (i32.add (local.get $hdr)
                     (i32.add (i32.const 4) (i32.mul (local.get $sidx) (i32.const 28)))))
    (local.set $flags (i32.load offset=16 (local.get $it)))
    (if (i32.and (local.get $flags) (i32.const 0x01))
      (then (return (i32.const -1))))
    (local.get $sidx))

  ;; ============================================================
  ;; $menu_load — parse the PE MENU resource ($find_resource(4, id))
  ;; into the heap-resident blob layout above and store the guest
  ;; pointer in MENU_DATA_TABLE[slot]. Replaces the JS encoder that
  ;; used to call menu_set with a pre-built blob.
  ;;
  ;; PE MENUITEMTEMPLATE format (we accept the standard, not MENUEX):
  ;;   MENUHEADER:  WORD wVersion=0; WORD cbHeaderSize=0;
  ;;   per item:    WORD fItemFlags;
  ;;                if !(fItemFlags & MF_POPUP=0x10): WORD wMenuID;
  ;;                WCHAR szString[]   (UTF-16, NUL-terminated)
  ;;                if fItemFlags & MF_POPUP: nested items follow
  ;;   MF_END=0x80 marks the last sibling at any level.
  ;;   MF_GRAYED=0x01, MF_SEPARATOR=0x800 may be ORed in.
  ;;
  ;; Top-level items become bar items. Popup children are preserved as
  ;; dropdown items; cascading sub-popups keep a nested child_offset so
  ;; TrackPopupMenu cascades render as grouped
  ;; submenus instead of one flattened command list.
  ;;
  ;; Two passes over the PE bytes:
  ;;   pass 1 — count $ml_bar_count, $ml_struct_size, $ml_string_size
  ;;   pass 2 — write into a freshly allocated heap blob, sized exactly
  ;; ============================================================

  ;; Read the label starting at $ml_pos, one $ml_char_stride-wide character at
  ;; a time. Advances $ml_pos past the trailing NUL, writes the char count to
  ;; $ml_label_chars, and returns the WASM addr of the first character.
  (func $ml_load_label (result i32)
    (local $start i32) (local $chars i32) (local $ch i32)
    (local.set $start (global.get $ml_pos))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $ch (call $ml_char_at (global.get $ml_pos) (i32.const 0)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (global.get $ml_char_stride)))
      (br_if $done (i32.eqz (local.get $ch)))
      (local.set $chars (i32.add (local.get $chars) (i32.const 1)))
      (br $scan)))
    (global.set $ml_label_chars (local.get $chars))
    (local.get $start))

  ;; Character $i of the label at $wa, in whichever width this template uses.
  (func $ml_char_at (param $wa i32) (param $i i32) (result i32)
    (local.set $wa (i32.add (local.get $wa)
      (i32.mul (local.get $i) (global.get $ml_char_stride))))
    (if (result i32) (i32.eq (global.get $ml_char_stride) (i32.const 1))
      (then (i32.load8_u (local.get $wa)))
      (else (i32.load16_u (local.get $wa)))))

  ;; Recursively consume one level of items WITHOUT counting them.
  ;; Used to skip cascading sub-popups in pass 1 / pass 2.
  (func $ml_skip_level
    (local $flags i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x10)))
        (then (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (drop (call $ml_load_label))
      (if (i32.and (local.get $flags) (i32.const 0x10))
        (then (call $ml_skip_level)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items))))

  ;; Pass 1 — children of one popup. Updates $ml_struct_size /
  ;; $ml_string_size. Counts direct children locally; nested popups recurse
  ;; and reserve their own child blocks.
  (func $ml_pass1_children
    (local $cc i32) (local $flags i32) (local $isPopup i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (local.set $isPopup (i32.and (local.get $flags) (i32.const 0x10)))
      (if (i32.eqz (local.get $isPopup))
        (then (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (drop (call $ml_load_label))
      (local.set $cc (i32.add (local.get $cc) (i32.const 1)))
      (global.set $ml_string_size
        (i32.add (global.get $ml_string_size) (global.get $ml_label_chars)))
      (if (local.get $isPopup)
        (then (call $ml_pass1_children)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items)))
    (if (local.get $cc)
      (then (global.set $ml_struct_size
              (i32.add (global.get $ml_struct_size)
                       (i32.add (i32.const 4) (i32.mul (local.get $cc) (i32.const 28))))))))

  ;; Pass 1 — top level. Walks each top item, counting bar slots and
  ;; recursing into children once for popups.
  (func $ml_pass1
    (local $flags i32) (local $chars i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (if (i32.eqz (i32.and (local.get $flags) (i32.const 0x10)))
        (then (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (drop (call $ml_load_label))
      (global.set $ml_bar_count (i32.add (global.get $ml_bar_count) (i32.const 1)))
      (global.set $ml_struct_size (i32.add (global.get $ml_struct_size) (i32.const 16)))
      (global.set $ml_string_size
        (i32.add (global.get $ml_string_size) (global.get $ml_label_chars)))
      (if (i32.and (local.get $flags) (i32.const 0x10))
        (then (call $ml_pass1_children)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items))))

  ;; MENUEX resources (wVersion=1) use DWORD type/state/id fields, a WORD
  ;; bResInfo (bit0 popup, bit7 end), DWORD alignment after each label, and a
  ;; popup help-id DWORD before the nested items.
  (func $mlex_align_pos
    (global.set $ml_pos
      (i32.and (i32.add (global.get $ml_pos) (i32.const 3)) (i32.const -4))))

  (func $mlex_skip_level
    (local $resInfo i32)
    (block $done (loop $items
      (br_if $done (i32.gt_u (i32.add (global.get $ml_pos) (i32.const 14)) (global.get $ml_end)))
      (local.set $resInfo (i32.load16_u (i32.add (global.get $ml_pos) (i32.const 12))))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 14)))
      (drop (call $ml_load_label))
      (call $mlex_align_pos)
      (if (i32.and (local.get $resInfo) (i32.const 1))
        (then
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 4)))
          (call $mlex_skip_level)))
      (br_if $done (i32.and (local.get $resInfo) (i32.const 0x80)))
      (br $items))))

  (func $mlex_pass1_children
    (local $cc i32) (local $resInfo i32)
    (block $done (loop $items
      (br_if $done (i32.gt_u (i32.add (global.get $ml_pos) (i32.const 14)) (global.get $ml_end)))
      (local.set $resInfo (i32.load16_u (i32.add (global.get $ml_pos) (i32.const 12))))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 14)))
      (drop (call $ml_load_label))
      (local.set $cc (i32.add (local.get $cc) (i32.const 1)))
      (global.set $ml_string_size
        (i32.add (global.get $ml_string_size) (global.get $ml_label_chars)))
      (call $mlex_align_pos)
      (if (i32.and (local.get $resInfo) (i32.const 1))
        (then
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 4)))
          (call $mlex_pass1_children)))
      (br_if $done (i32.and (local.get $resInfo) (i32.const 0x80)))
      (br $items)))
    (if (local.get $cc)
      (then (global.set $ml_struct_size
              (i32.add (global.get $ml_struct_size)
                       (i32.add (i32.const 4) (i32.mul (local.get $cc) (i32.const 28))))))))

  (func $mlex_pass1
    (local $resInfo i32)
    (block $done (loop $items
      (br_if $done (i32.gt_u (i32.add (global.get $ml_pos) (i32.const 14)) (global.get $ml_end)))
      (local.set $resInfo (i32.load16_u (i32.add (global.get $ml_pos) (i32.const 12))))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 14)))
      (drop (call $ml_load_label))
      (global.set $ml_bar_count (i32.add (global.get $ml_bar_count) (i32.const 1)))
      (global.set $ml_struct_size (i32.add (global.get $ml_struct_size) (i32.const 16)))
      (global.set $ml_string_size
        (i32.add (global.get $ml_string_size) (global.get $ml_label_chars)))
      (call $mlex_align_pos)
      (if (i32.and (local.get $resInfo) (i32.const 1))
        (then
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 4)))
          (call $mlex_pass1_children)))
      (br_if $done (i32.and (local.get $resInfo) (i32.const 0x80)))
      (br $items))))

  ;; Find the first '\t' (0x09) in a label, or -1.
  (func $ml_find_tab (param $wa i32) (param $chars i32) (result i32)
    (local $i i32)
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $chars)))
      (if (i32.eq (call $ml_char_at (local.get $wa) (local.get $i)) (i32.const 0x09))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Copy $chars characters from $src_wa to $dst_wa as ASCII (low byte).
  (func $ml_copy_ascii (param $src_wa i32) (param $dst_wa i32) (param $chars i32)
    (local $i i32)
    (block $done (loop $cp
      (br_if $done (i32.ge_u (local.get $i) (local.get $chars)))
      (i32.store8 (i32.add (local.get $dst_wa) (local.get $i))
                  (call $ml_char_at (local.get $src_wa) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cp))))

  ;; Write one dropdown item record at explicit struct offset $rec_off.
  (func $ml_write_child_record (param $rec_off i32) (param $flags i32) (param $id i32)
                               (param $str_w i32) (param $chars i32) (param $child_off i32)
    (local $hdr_off i32) (local $tab i32)
    (local $label_chars i32) (local $sc_chars i32)
    (local $label_off i32) (local $sc_off i32) (local $out_flags i32)
    (local.set $hdr_off (local.get $rec_off))
    ;; Split label on '\t' for shortcut
    (local.set $tab (call $ml_find_tab (local.get $str_w) (local.get $chars)))
    (if (i32.ge_s (local.get $tab) (i32.const 0))
      (then
        (local.set $label_chars (local.get $tab))
        (local.set $sc_chars (i32.sub (i32.sub (local.get $chars) (local.get $tab)) (i32.const 1))))
      (else
        (local.set $label_chars (local.get $chars))
        (local.set $sc_chars (i32.const 0))))
    ;; Copy label to string region
    (local.set $label_off (global.get $ml_string_cur))
    (call $ml_copy_ascii (local.get $str_w)
          (i32.add (global.get $ml_blob_w) (global.get $ml_string_cur))
          (local.get $label_chars))
    (global.set $ml_string_cur (i32.add (global.get $ml_string_cur) (local.get $label_chars)))
    (local.set $sc_off (i32.const 0))
    (if (local.get $sc_chars)
      (then
        (local.set $sc_off (global.get $ml_string_cur))
        (call $ml_copy_ascii
          (i32.add (local.get $str_w) (i32.shl (i32.add (local.get $tab) (i32.const 1))
                                                (i32.const 1)))
          (i32.add (global.get $ml_blob_w) (global.get $ml_string_cur))
          (local.get $sc_chars))
        (global.set $ml_string_cur (i32.add (global.get $ml_string_cur) (local.get $sc_chars)))))
    ;; Out flags: bit0 separator, bit1 grayed, bit2 checked, bit3 popup
    (local.set $out_flags (i32.const 0))
    (if (i32.or (i32.and (local.get $flags) (i32.const 0x800))
                (i32.and (i32.eqz (local.get $chars))
                         (i32.eqz (local.get $id))))
      (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 1)))))
    (if (i32.and (local.get $flags) (i32.const 0x01))
      (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 2)))))
    (if (i32.and (local.get $flags) (i32.const 0x08))
      (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 4)))))
    (if (local.get $child_off)
      (then (local.set $out_flags (i32.or (local.get $out_flags) (i32.const 8)))))
    ;; Write the child item record (28 bytes) at hdr_off.
    (i32.store           (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $label_off))
    (i32.store offset=4  (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $label_chars))
    (i32.store offset=8  (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $sc_off))
    (i32.store offset=12 (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $sc_chars))
    (i32.store offset=16 (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $out_flags))
    (i32.store offset=20 (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $id))
    (i32.store offset=24 (i32.add (global.get $ml_blob_w) (local.get $hdr_off)) (local.get $child_off)))

  ;; Count direct children at the current level, consuming nested popup
  ;; payloads only to skip them. Caller saves/restores $ml_pos around this.
  (func $ml_count_direct_children (result i32)
    (local $cc i32) (local $flags i32) (local $isPopup i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (local.set $isPopup (i32.and (local.get $flags) (i32.const 0x10)))
      (if (i32.eqz (local.get $isPopup))
        (then (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (drop (call $ml_load_label))
      (local.set $cc (i32.add (local.get $cc) (i32.const 1)))
      (if (local.get $isPopup)
        (then (call $ml_skip_level)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items)))
    (local.get $cc))

  ;; Pass 2 — children of one popup. Walks PE bytes the same way, fills
  ;; the child block at $ml_struct_cur. The direct item array must stay
  ;; contiguous, so it is reserved first and nested child blocks are appended
  ;; after it. Returns direct child count.
  (func $ml_pass2_children (result i32)
    (local $cc i32) (local $flags i32) (local $id i32)
    (local $str_w i32) (local $chars i32)
    (local $start_pos i32) (local $count_off i32) (local $rec_off i32)
    (local $child_off i32) (local $sub_count i32)
    (local $isPopup i32)
    (local.set $start_pos (global.get $ml_pos))
    (local.set $cc (call $ml_count_direct_children))
    (global.set $ml_pos (local.get $start_pos))
    (if (i32.eqz (local.get $cc)) (then (return (i32.const 0))))
    (local.set $count_off (global.get $ml_struct_cur))
    (global.set $ml_struct_cur
      (i32.add (global.get $ml_struct_cur)
               (i32.add (i32.const 4) (i32.mul (local.get $cc) (i32.const 28)))))
    (i32.store (i32.add (global.get $ml_blob_w) (local.get $count_off)) (local.get $cc))
    (local.set $rec_off (i32.add (local.get $count_off) (i32.const 4)))
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (local.set $isPopup (i32.and (local.get $flags) (i32.const 0x10)))
      (local.set $id (i32.const 0))
      (if (i32.eqz (local.get $isPopup))
        (then
          (local.set $id (i32.load16_u (global.get $ml_pos)))
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (local.set $str_w (call $ml_load_label))
      (local.set $chars (global.get $ml_label_chars))
      (local.set $child_off (i32.const 0))
      (if (local.get $isPopup)
        (then
          (local.set $child_off (global.get $ml_struct_cur))
          (local.set $sub_count (call $ml_pass2_children))
          (if (i32.eqz (local.get $sub_count))
            (then (local.set $child_off (i32.const 0))))))
      (call $ml_write_child_record
        (local.get $rec_off) (local.get $flags) (local.get $id)
        (local.get $str_w) (local.get $chars) (local.get $child_off))
      (local.set $rec_off (i32.add (local.get $rec_off) (i32.const 28)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items)))
    (local.get $cc))

  ;; Pass 2 — top level. Writes bar items at fixed offsets and recurses
  ;; into children for each popup.
  (func $ml_pass2
    (local $bar_idx i32) (local $flags i32) (local $id i32)
    (local $isPopup i32) (local $str_w i32) (local $chars i32)
    (local $bar_addr i32) (local $label_off i32)
    (local $child_off i32) (local $cc i32)
    (block $done (loop $items
      (br_if $done (i32.ge_u (global.get $ml_pos) (global.get $ml_end)))
      (br_if $done (i32.ge_u (local.get $bar_idx) (global.get $ml_bar_count)))
      (local.set $flags (i32.load16_u (global.get $ml_pos)))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))
      (local.set $isPopup (i32.and (local.get $flags) (i32.const 0x10)))
      (local.set $id (i32.const 0))
      (if (i32.eqz (local.get $isPopup))
        (then
          (local.set $id (i32.load16_u (global.get $ml_pos)))
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 2)))))
      (local.set $str_w (call $ml_load_label))
      (local.set $chars (global.get $ml_label_chars))
      (local.set $bar_addr
        (i32.add (global.get $ml_blob_w)
                 (i32.add (i32.const 4) (i32.mul (local.get $bar_idx) (i32.const 16)))))
      ;; Copy bar label
      (local.set $label_off (global.get $ml_string_cur))
      (call $ml_copy_ascii (local.get $str_w)
            (i32.add (global.get $ml_blob_w) (global.get $ml_string_cur))
            (local.get $chars))
      (global.set $ml_string_cur (i32.add (global.get $ml_string_cur) (local.get $chars)))
      (i32.store          (local.get $bar_addr) (local.get $label_off))
      (i32.store offset=4 (local.get $bar_addr) (local.get $chars))
      (i32.store offset=8 (local.get $bar_addr) (i32.const 0))
      (i32.store offset=12 (local.get $bar_addr) (local.get $id))
      (if (local.get $isPopup)
        (then
          (local.set $child_off (global.get $ml_struct_cur))
          (local.set $cc (call $ml_pass2_children))
          (if (local.get $cc)
            (then (i32.store offset=8 (local.get $bar_addr) (local.get $child_off))))))
      (local.set $bar_idx (i32.add (local.get $bar_idx) (i32.const 1)))
      (br_if $done (i32.and (local.get $flags) (i32.const 0x80)))
      (br $items))))

  (func $mlex_count_direct_children (result i32)
    (local $cc i32) (local $resInfo i32)
    (block $done (loop $items
      (br_if $done (i32.gt_u (i32.add (global.get $ml_pos) (i32.const 14)) (global.get $ml_end)))
      (local.set $resInfo (i32.load16_u (i32.add (global.get $ml_pos) (i32.const 12))))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 14)))
      (drop (call $ml_load_label))
      (local.set $cc (i32.add (local.get $cc) (i32.const 1)))
      (call $mlex_align_pos)
      (if (i32.and (local.get $resInfo) (i32.const 1))
        (then
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 4)))
          (call $mlex_skip_level)))
      (br_if $done (i32.and (local.get $resInfo) (i32.const 0x80)))
      (br $items)))
    (local.get $cc))

  (func $mlex_pass2_children (result i32)
    (local $cc i32) (local $type i32) (local $state i32) (local $id i32)
    (local $resInfo i32) (local $flags i32) (local $str_w i32) (local $chars i32)
    (local $start_pos i32) (local $count_off i32) (local $rec_off i32)
    (local $child_off i32) (local $sub_count i32)
    (local.set $start_pos (global.get $ml_pos))
    (local.set $cc (call $mlex_count_direct_children))
    (global.set $ml_pos (local.get $start_pos))
    (if (i32.eqz (local.get $cc)) (then (return (i32.const 0))))
    (local.set $count_off (global.get $ml_struct_cur))
    (global.set $ml_struct_cur
      (i32.add (global.get $ml_struct_cur)
               (i32.add (i32.const 4) (i32.mul (local.get $cc) (i32.const 28)))))
    (i32.store (i32.add (global.get $ml_blob_w) (local.get $count_off)) (local.get $cc))
    (local.set $rec_off (i32.add (local.get $count_off) (i32.const 4)))
    (block $done (loop $items
      (br_if $done (i32.gt_u (i32.add (global.get $ml_pos) (i32.const 14)) (global.get $ml_end)))
      (local.set $type (i32.load (global.get $ml_pos)))
      (local.set $state (i32.load offset=4 (global.get $ml_pos)))
      (local.set $id (i32.load offset=8 (global.get $ml_pos)))
      (local.set $resInfo (i32.load16_u (i32.add (global.get $ml_pos) (i32.const 12))))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 14)))
      (local.set $str_w (call $ml_load_label))
      (local.set $chars (global.get $ml_label_chars))
      (call $mlex_align_pos)
      (local.set $flags (i32.and (local.get $type) (i32.const 0x800)))
      (if (i32.and (local.get $state) (i32.const 3))
        (then (local.set $flags (i32.or (local.get $flags) (i32.const 1)))))
      ;; MENUEX stores MFS_CHECKED in dwState, while the shared record writer
      ;; consumes the equivalent classic MF_CHECKED bit.
      (if (i32.and (local.get $state) (i32.const 8))
        (then (local.set $flags (i32.or (local.get $flags) (i32.const 8)))))
      (local.set $child_off (i32.const 0))
      (if (i32.and (local.get $resInfo) (i32.const 1))
        (then
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 4)))
          (local.set $child_off (global.get $ml_struct_cur))
          (local.set $sub_count (call $mlex_pass2_children))
          (if (i32.eqz (local.get $sub_count))
            (then (local.set $child_off (i32.const 0))))))
      (call $ml_write_child_record
        (local.get $rec_off) (local.get $flags) (local.get $id)
        (local.get $str_w) (local.get $chars) (local.get $child_off))
      (local.set $rec_off (i32.add (local.get $rec_off) (i32.const 28)))
      (br_if $done (i32.and (local.get $resInfo) (i32.const 0x80)))
      (br $items)))
    (local.get $cc))

  (func $mlex_pass2
    (local $bar_idx i32) (local $id i32) (local $resInfo i32)
    (local $str_w i32) (local $chars i32) (local $bar_addr i32)
    (local $label_off i32) (local $child_off i32) (local $cc i32)
    (block $done (loop $items
      (br_if $done (i32.gt_u (i32.add (global.get $ml_pos) (i32.const 14)) (global.get $ml_end)))
      (br_if $done (i32.ge_u (local.get $bar_idx) (global.get $ml_bar_count)))
      (local.set $id (i32.load offset=8 (global.get $ml_pos)))
      (local.set $resInfo (i32.load16_u (i32.add (global.get $ml_pos) (i32.const 12))))
      (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 14)))
      (local.set $str_w (call $ml_load_label))
      (local.set $chars (global.get $ml_label_chars))
      (call $mlex_align_pos)
      (local.set $bar_addr
        (i32.add (global.get $ml_blob_w)
                 (i32.add (i32.const 4) (i32.mul (local.get $bar_idx) (i32.const 16)))))
      (local.set $label_off (global.get $ml_string_cur))
      (call $ml_copy_ascii (local.get $str_w)
            (i32.add (global.get $ml_blob_w) (global.get $ml_string_cur))
            (local.get $chars))
      (global.set $ml_string_cur (i32.add (global.get $ml_string_cur) (local.get $chars)))
      (i32.store          (local.get $bar_addr) (local.get $label_off))
      (i32.store offset=4 (local.get $bar_addr) (local.get $chars))
      (i32.store offset=8 (local.get $bar_addr) (i32.const 0))
      (i32.store offset=12 (local.get $bar_addr) (local.get $id))
      (if (i32.and (local.get $resInfo) (i32.const 1))
        (then
          (global.set $ml_pos (i32.add (global.get $ml_pos) (i32.const 4)))
          (local.set $child_off (global.get $ml_struct_cur))
          (local.set $cc (call $mlex_pass2_children))
          (if (local.get $cc)
            (then (i32.store offset=8 (local.get $bar_addr) (local.get $child_off))))))
      (local.set $bar_idx (i32.add (local.get $bar_idx) (i32.const 1)))
      (br_if $done (i32.and (local.get $resInfo) (i32.const 0x80)))
      (br $items))))

  ;; Public entry: load the menu identified by $menu_id (RT_MENU=4) for
  ;; $hwnd. Pass menu_id=0 to clear. Skips the load entirely if this
  ;; slot already has a blob — callers may invoke this multiple times
  ;; (eager path in $handle_CreateWindowExA, lazy path from renderer
  ;; _ensureWatMenu) and the first load wins so mutable state such as
  ;; CheckMenuItem's bit2 flag survives subsequent calls.
  (func $menu_load (export "menu_load") (param $hwnd i32) (param $menu_id i32)
    (local $slot i32) (local $tbl i32) (local $old i32)
    (local $entry i32) (local $bytes_g i32) (local $bytes_w i32)
    (local $size i32) (local $total i32) (local $newg i32)
    (local $source_id i32)
    (local $version i32) (local $headerOffset i32) (local $items_w i32)
    (local.set $source_id (local.get $menu_id))
    (local.set $slot (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $slot) (i32.const -1)) (then (return)))
    (local.set $tbl (call $menu_data_table_addr (local.get $slot)))
    (local.set $old (i32.load (local.get $tbl)))
    (if (i32.eqz (local.get $menu_id))
      (then
        (if (local.get $old)
          (then (call $heap_free (i32.sub (local.get $old) (i32.const 8)))))
        (i32.store (local.get $tbl) (i32.const 0))
        (return)))
    (if (local.get $old) (then (return)))
    ;; LoadMenuA returns `resId | 0x00BE0000` as a fake handle. When MFC's
    ;; CreateWindowExA(hMenu=...) forwards that value through to us, strip
    ;; the tag so find_resource sees the raw resource ID.
    (if (i32.eq (i32.and (local.get $menu_id) (i32.const 0xFFFF0000))
                (i32.const 0x00BE0000))
      (then (local.set $menu_id (i32.and (local.get $menu_id) (i32.const 0xFFFF)))))
    ;; Resolve resource bytes. An NE image keeps its menus in a flat resource
    ;; table with none of the PE tree, and stores the same MENUITEMTEMPLATE
    ;; with ANSI rather than UTF-16 labels — which is the whole difference, so
    ;; both feed the one parser below with the character width set here.
    (if (global.get $code16)
      (then
        (global.set $ml_char_stride (i32.const 1))
        (local.set $bytes_w (call $win16_find_resource (i32.const 4) (local.get $menu_id)))
        (if (i32.eqz (local.get $bytes_w)) (then (return)))
        (local.set $size (global.get $win16_res_len)))
      (else
        (global.set $ml_char_stride (i32.const 2))
        (local.set $entry (call $find_resource (i32.const 4) (local.get $menu_id)))
        (if (i32.eqz (local.get $entry)) (then (return)))
        ;; data entry: i32 RVA, i32 size
        (local.set $bytes_g (i32.add (call $r_base)
                              (i32.load (call $g2w (i32.add (call $r_base) (local.get $entry))))))
        (local.set $size (i32.load (call $g2w (i32.add (call $r_base)
                                                        (i32.add (local.get $entry) (i32.const 4))))))
        (local.set $bytes_w (call $g2w (local.get $bytes_g)))))
    (if (i32.lt_u (local.get $size) (i32.const 8)) (then (return)))
    (local.set $version (i32.load16_u (local.get $bytes_w)))
    (local.set $headerOffset (i32.load16_u (i32.add (local.get $bytes_w) (i32.const 2))))
    (if (i32.gt_u (local.get $version) (i32.const 1)) (then (return)))
    (local.set $items_w
      (i32.add (local.get $bytes_w) (i32.add (i32.const 4) (local.get $headerOffset))))
    ;; --- Pass 1: count ---
    (global.set $ml_pos (local.get $items_w))
    (global.set $ml_end (i32.add (local.get $bytes_w) (local.get $size)))
    (global.set $ml_bar_count   (i32.const 0))
    (global.set $ml_struct_size (i32.const 4)) ;; bar_count header
    (global.set $ml_string_size (i32.const 0))
    (if (local.get $version)
      (then (call $mlex_pass1))
      (else (call $ml_pass1)))
    (if (i32.eqz (global.get $ml_bar_count)) (then (return)))
    ;; --- Allocate blob and run pass 2 ---
    (local.set $total (i32.add (global.get $ml_struct_size) (global.get $ml_string_size)))
    (local.set $newg (call $heap_alloc (i32.add (local.get $total) (i32.const 8))))
    (i32.store (call $g2w (local.get $newg)) (local.get $source_id))
    (i32.store offset=4 (call $g2w (local.get $newg)) (local.get $total))
    (i32.store (local.get $tbl) (i32.add (local.get $newg) (i32.const 8)))
    (global.set $ml_blob_w (call $g2w (i32.add (local.get $newg) (i32.const 8))))
    ;; bar_count header
    (i32.store (global.get $ml_blob_w) (global.get $ml_bar_count))
    ;; cursors: $ml_struct_cur runs forward through bar items + child
    ;; blocks; $ml_string_cur runs forward through the string region
    ;; that begins right after the struct region.
    (global.set $ml_string_cur (global.get $ml_struct_size))
    (global.set $ml_struct_cur
      (i32.add (i32.const 4) (i32.mul (global.get $ml_bar_count) (i32.const 16))))
    (global.set $ml_pos (local.get $items_w))
    (if (local.get $version)
      (then (call $mlex_pass2))
      (else (call $ml_pass2))))

  ;; ============================================================
  ;; Menu tracking — JS shells out raw mouse / keyboard events to
  ;; the helpers below; all open/close/hover/activate logic lives
  ;; here. State is in $menu_open_hwnd / $menu_open_top /
  ;; $menu_open_hover (one menu open at a time, system-wide).
  ;;
  ;; Activations post WM_COMMAND (or WM_CLOSE for File→Exit, id=28)
  ;; into the existing post queue at WASM addr 0x400 (same one
  ;; PostMessageA writes to). The host pump dequeues and dispatches
  ;; on the next iteration.
  ;; ============================================================

  (func (export "menu_open_hwnd")  (result i32) (global.get $menu_open_hwnd))
  (func (export "menu_open_top")   (result i32) (global.get $menu_open_top))
  (func (export "menu_open_hover") (result i32) (global.get $menu_open_hover))
  (func (export "menu_open_sub_hover") (result i32) (global.get $menu_open_sub_hover))
  (func (export "menu_open_x")     (result i32) (global.get $menu_open_x))
  (func (export "menu_open_y")     (result i32) (global.get $menu_open_y))

  ;; Exported so a trace can say where the dropdown and its cascade are:
  ;; "the submenu was never highlighted" and "the pointer was aimed left of
  ;; the submenu" are the same subhover=-1 without them.
  (func $menu_dropdown_x (export "menu_dropdown_x") (param $hwnd i32) (param $top i32) (result i32)
    (if (i32.ge_s (global.get $menu_open_x) (i32.const 0))
      (then (return (global.get $menu_open_x))))
    (i32.add (call $menu_bar_screen_x (local.get $hwnd))
             (call $menu_bar_item_x (local.get $hwnd) (local.get $top))))

  (func $menu_dropdown_y (export "menu_dropdown_y") (param $hwnd i32) (result i32)
    (if (i32.ge_s (global.get $menu_open_y) (i32.const 0))
      (then (return (global.get $menu_open_y))))
    (i32.add (call $menu_bar_screen_y (local.get $hwnd)) (call $menu_bar_screen_h)))

  ;; Number of items currently being tracked (0 if no menu open).
  (func $menu_track_child_count (result i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return (i32.const 0))))
    (call $menu_child_count (global.get $menu_open_hwnd) (global.get $menu_open_top)))

  (func $menu_sub_track_child_count (result i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return (i32.const 0))))
    (if (i32.lt_s (global.get $menu_open_hover) (i32.const 0)) (then (return (i32.const 0))))
    (call $menu_child_sub_count
      (global.get $menu_open_hwnd) (global.get $menu_open_top) (global.get $menu_open_hover)))

  (func $menu_sub_first_selectable (result i32)
    (local $n i32) (local $i i32) (local $f i32)
    (local.set $n (call $menu_sub_track_child_count))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $f (call $menu_subchild_flags
        (global.get $menu_open_hwnd)
        (global.get $menu_open_top)
        (global.get $menu_open_hover)
        (local.get $i)))
      (if (i32.eqz (i32.and (local.get $f) (i32.const 0x03)))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; ---- Menu handle queries (GetMenuItemCount / GetMenuItemID / GetMenuState)
  ;;
  ;; A menu handle here is the window's own menu id, and GetSubMenu turns that
  ;; into (hmenu & 0xFFFF) | ((pos+1) << 16). So the low word identifies which
  ;; window's menu this is, and a non-matching high word says which dropdown.
  ;; Find the window by the low word and everything else follows from the menu
  ;; model we already keep.
  (func $menu_hwnd_from_handle (param $hmenu i32) (result i32)
    (local $i i32) (local $hwnd i32) (local $src i32)
    (if (i32.eqz (local.get $hmenu)) (then (return (i32.const 0))))
    (block $done
      (loop $wins
        (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
        (local.set $hwnd (i32.load (call $wnd_record_addr (local.get $i))))
        (if (local.get $hwnd)
          (then
            (local.set $src (call $menu_source_get (local.get $hwnd)))
            (if (i32.eqz (local.get $src))
              (then (if (i32.gt_s (call $menu_bar_count (local.get $hwnd)) (i32.const 0))
                (then (local.set $src (i32.const 0x80001))))))
            (if (local.get $src)
              (then
                (if (i32.eq (i32.and (local.get $src) (i32.const 0xFFFF))
                            (i32.and (local.get $hmenu) (i32.const 0xFFFF)))
                  (then (return (local.get $hwnd))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $wins)))
    (i32.const 0))

  ;; Is this handle the menu bar itself, or one of its dropdowns? The bar's
  ;; handle is whatever GetMenu hands out; a dropdown always carries pos+1 in
  ;; its high word, so it differs from the bar's own handle.
  (func $menu_handle_top_index (param $hwnd i32) (param $hmenu i32) (result i32)
    (local $src i32)
    (local.set $src (call $menu_source_get (local.get $hwnd)))
    (if (i32.eqz (local.get $src)) (then (local.set $src (i32.const 0x80001))))
    (if (i32.eq (local.get $src) (local.get $hmenu)) (then (return (i32.const -1))))
    (i32.sub (i32.shr_u (local.get $hmenu) (i32.const 16)) (i32.const 1)))

  (func $menu_handle_item_count (export "menu_handle_item_count")
        (param $hmenu i32) (result i32)
    (local $hwnd i32) (local $top i32)
    (local.set $hwnd (call $menu_hwnd_from_handle (local.get $hmenu)))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $top (call $menu_handle_top_index (local.get $hwnd) (local.get $hmenu)))
    (if (i32.lt_s (local.get $top) (i32.const 0))
      (then (return (call $menu_bar_count (local.get $hwnd)))))
    (call $menu_child_count (local.get $hwnd) (local.get $top)))

  ;; Command id at a position. A submenu or separator has none, and Windows
  ;; answers 0 for both.
  (func $menu_handle_item_id (export "menu_handle_item_id")
        (param $hmenu i32) (param $pos i32) (result i32)
    (local $hwnd i32) (local $top i32)
    (local.set $hwnd (call $menu_hwnd_from_handle (local.get $hmenu)))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $top (call $menu_handle_top_index (local.get $hwnd) (local.get $hmenu)))
    (if (i32.lt_s (local.get $top) (i32.const 0))
      (then (return (call $menu_bar_id (local.get $hwnd) (local.get $pos)))))
    (if (i32.ge_u (local.get $pos) (call $menu_child_count (local.get $hwnd) (local.get $top)))
      (then (return (i32.const 0))))
    (call $menu_child_id (local.get $hwnd) (local.get $top) (local.get $pos)))

  ;; Our item flags are internal (bit 1 = disabled, bit 2 = checked); Windows
  ;; wants MF_GRAYED 1 / MF_DISABLED 2 / MF_CHECKED 8. Translate rather than
  ;; leak the internal encoding through the API.
  (func $menu_flags_to_mf (param $flags i32) (result i32)
    (i32.or
      (select (i32.const 3) (i32.const 0)
        (i32.ne (i32.and (local.get $flags) (i32.const 2)) (i32.const 0)))
      (select (i32.const 8) (i32.const 0)
        (i32.ne (i32.and (local.get $flags) (i32.const 4)) (i32.const 0)))))

  (func $menu_handle_item_state (export "menu_handle_item_state")
        (param $hmenu i32) (param $pos i32) (result i32)
    (local $hwnd i32) (local $top i32)
    (local.set $hwnd (call $menu_hwnd_from_handle (local.get $hmenu)))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const -1))))
    (local.set $top (call $menu_handle_top_index (local.get $hwnd) (local.get $hmenu)))
    (if (i32.lt_s (local.get $top) (i32.const 0)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $pos) (call $menu_child_count (local.get $hwnd) (local.get $top)))
      (then (return (i32.const -1))))
    (call $menu_flags_to_mf
      (call $menu_child_flags (local.get $hwnd) (local.get $top) (local.get $pos))))

  ;; Same, addressed by command id rather than position -- MF_BYCOMMAND.
  (func $menu_handle_state_by_id (export "menu_handle_state_by_id")
        (param $hmenu i32) (param $id i32) (result i32)
    (local $hwnd i32) (local $bar i32) (local $bars i32)
    (local $i i32) (local $n i32)
    (local.set $hwnd (call $menu_hwnd_from_handle (local.get $hmenu)))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const -1))))
    (local.set $bars (call $menu_bar_count (local.get $hwnd)))
    (block $done
      (loop $tops
        (br_if $done (i32.ge_s (local.get $bar) (local.get $bars)))
        (local.set $n (call $menu_child_count (local.get $hwnd) (local.get $bar)))
        (local.set $i (i32.const 0))
        (block $next (loop $items
          (br_if $next (i32.ge_u (local.get $i) (local.get $n)))
          (if (i32.eq (call $menu_child_id (local.get $hwnd) (local.get $bar) (local.get $i))
                      (local.get $id))
            (then (return (call $menu_flags_to_mf
              (call $menu_child_flags (local.get $hwnd) (local.get $bar) (local.get $i))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $items)))
        (local.set $bar (i32.add (local.get $bar) (i32.const 1)))
        (br $tops)))
    (i32.const -1))

  ;; Resolve a handle+item pair to (top index, child index). Returns -1 in the
  ;; high half when the item is not found. Packed because WAT has no tuples:
  ;; (top << 16) | child, or -1.
  (func $menu_handle_locate (param $hmenu i32) (param $item i32) (param $by_pos i32) (result i32)
    (local $hwnd i32) (local $top i32) (local $bar i32) (local $bars i32)
    (local $i i32) (local $n i32)
    (local.set $hwnd (call $menu_hwnd_from_handle (local.get $hmenu)))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const -1))))
    (if (local.get $by_pos)
      (then
        (local.set $top (call $menu_handle_top_index (local.get $hwnd) (local.get $hmenu)))
        (if (i32.lt_s (local.get $top) (i32.const 0)) (then (return (i32.const -1))))
        (if (i32.ge_u (local.get $item) (call $menu_child_count (local.get $hwnd) (local.get $top)))
          (then (return (i32.const -1))))
        (return (i32.or (i32.shl (local.get $top) (i32.const 16)) (local.get $item)))))
    ;; By command id: the id is unique across the whole menu, so scan it all.
    (local.set $bars (call $menu_bar_count (local.get $hwnd)))
    (block $done
      (loop $tops
        (br_if $done (i32.ge_s (local.get $bar) (local.get $bars)))
        (local.set $n (call $menu_child_count (local.get $hwnd) (local.get $bar)))
        (local.set $i (i32.const 0))
        (block $next (loop $items
          (br_if $next (i32.ge_u (local.get $i) (local.get $n)))
          (if (i32.eq (call $menu_child_id (local.get $hwnd) (local.get $bar) (local.get $i))
                      (local.get $item))
            (then (return (i32.or (i32.shl (local.get $bar) (i32.const 16)) (local.get $i)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $items)))
        (local.set $bar (i32.add (local.get $bar) (i32.const 1)))
        (br $tops)))
    (i32.const -1))

  ;; GetMenuString's body. $out_wa is a linear address; $cch counts bytes
  ;; including the terminator, as Windows does. Returns characters copied.
  (func $menu_handle_copy_label (export "menu_handle_copy_label")
        (param $hmenu i32) (param $item i32) (param $by_pos i32)
        (param $out_wa i32) (param $cch i32) (result i32)
    (local $hwnd i32) (local $loc i32) (local $top i32) (local $child i32)
    (local $src i32) (local $len i32) (local $dyn i32) (local $idx i32) (local $rec i32)
    (block $found
      ;; A CreatePopupMenu handle belongs to no window, so the lookup below
      ;; could never resolve one and every app that read back a label it had
      ;; just appended got an empty string. Answer from the item records.
      (local.set $dyn (call $dynamic_menu_state_w (local.get $hmenu)))
      (if (local.get $dyn)
        (then
          (local.set $idx
            (if (result i32) (local.get $by_pos)
              (then (local.get $item))
              (else (call $dynamic_menu_index_of_id (local.get $dyn) (local.get $item)))))
          (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
          (if (i32.ge_u (local.get $idx) (i32.load offset=4 (local.get $dyn)))
            (then (return (i32.const 0))))
          (local.set $rec (i32.add (local.get $dyn)
            (i32.add (i32.const 16) (i32.mul (local.get $idx) (i32.const 16)))))
          (local.set $src (call $dynamic_item_label_w (local.get $rec)))
          (if (i32.eqz (local.get $src)) (then (return (i32.const 0))))
          ;; Win32 hands back the whole string it was given, shortcut included.
          (local.set $len (call $strlen (local.get $src)))
          (br $found)))
      (local.set $hwnd (call $menu_hwnd_from_handle (local.get $hmenu)))
      (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
      (local.set $loc (call $menu_handle_locate
        (local.get $hmenu) (local.get $item) (local.get $by_pos)))
      (if (i32.eq (local.get $loc) (i32.const -1)) (then (return (i32.const 0))))
      (local.set $top (i32.shr_u (local.get $loc) (i32.const 16)))
      (local.set $child (i32.and (local.get $loc) (i32.const 0xFFFF)))
      (local.set $src (call $menu_child_label_ptr
        (local.get $hwnd) (local.get $top) (local.get $child)))
      (local.set $len (call $menu_child_label_len
        (local.get $hwnd) (local.get $top) (local.get $child))))
    ;; A NULL buffer means "just tell me how long it is".
    (if (i32.eqz (local.get $out_wa)) (then (return (local.get $len))))
    (if (i32.eqz (local.get $cch)) (then (return (i32.const 0))))
    (if (i32.ge_u (local.get $len) (local.get $cch))
      (then (local.set $len (i32.sub (local.get $cch) (i32.const 1)))))
    (if (local.get $len)
      (then (call $memcpy (local.get $out_wa) (local.get $src) (local.get $len))))
    (i32.store8 (i32.add (local.get $out_wa) (local.get $len)) (i32.const 0))
    (local.get $len))

  ;; Opening a dropdown is an app's cue to bring the menu up to date, and it
  ;; was never given: WM_INITMENU and WM_INITMENUPOPUP were not sent by
  ;; anything. That is where every MFC app runs its ON_UPDATE_COMMAND_UI
  ;; handlers, so their menus showed whatever state the resource shipped with
  ;; -- Paint offered File > Send... in black on a machine with no mail
  ;; subsystem, and clicking it correctly did nothing, which reads from the
  ;; outside exactly like a broken command.
  ;;
  ;; These are posted rather than sent. A dropdown stays open for many frames
  ;; and is repainted from this model each time, so the app's EnableMenuItem
  ;; calls land well before anyone can pick an item -- and posting avoids
  ;; re-entering a guest wndproc from inside the click that opened the menu.
  ;;
  ;; The submenu handle follows GetSubMenu's encoding, (hmenu & 0xFFFF) |
  ;; ((pos+1) << 16), so an app that stashes what GetSubMenu gave it compares
  ;; equal to what arrives here.
  (func $menu_init_popup (param $hwnd i32) (param $top_idx i32)
    (local $hmenu i32)
    (local.set $hmenu (call $menu_source_get (local.get $hwnd)))
    (if (i32.eqz (local.get $hmenu))
      (then (local.set $hmenu (i32.const 0x80001))))
    (call $menu_post (local.get $hwnd) (i32.const 0x0116)   ;; WM_INITMENU
      (local.get $hmenu) (i32.const 0))
    (call $menu_post (local.get $hwnd) (i32.const 0x0117)   ;; WM_INITMENUPOPUP
      (i32.or (i32.and (local.get $hmenu) (i32.const 0xFFFF))
              (i32.shl (i32.add (local.get $top_idx) (i32.const 1)) (i32.const 16)))
      (local.get $top_idx)))

  (func $menu_open (export "menu_open") (param $hwnd i32) (param $top_idx i32)
    (if (global.get $menu_open_popup_blob)
      (then
        (call $heap_free (global.get $menu_open_popup_blob))
        (global.set $menu_open_popup_blob (i32.const 0))))
    (global.set $menu_open_hwnd  (local.get $hwnd))
    (global.set $menu_open_top   (local.get $top_idx))
    (global.set $menu_open_hover (i32.const -1))
    (global.set $menu_open_sub_hover (i32.const -1))
    (global.set $menu_open_x     (i32.const -1))
    (global.set $menu_open_y     (i32.const -1))
    (call $menu_init_popup (local.get $hwnd) (local.get $top_idx)))

  (func $menu_track_popup_open (export "menu_track_popup_open")
        (param $hmenu i32) (param $flags i32) (param $x i32) (param $y i32) (param $hwnd i32)
        (result i32)
    (local $menu_id i32) (local $top_idx i32)
    ;; TPM_RETURNCMD asks USER32 to return the selected command synchronously.
    ;; We do not run a nested modal menu loop yet, so report no selection.
    (if (i32.and (local.get $flags) (i32.const 0x0100)) (then (return (i32.const 0))))
    (if (call $dynamic_menu_state_w (local.get $hmenu))
      (then
        (if (global.get $menu_open_popup_blob)
          (then
            (call $heap_free (global.get $menu_open_popup_blob))
            (global.set $menu_open_popup_blob (i32.const 0))))
        (global.set $menu_open_popup_blob
          (call $dynamic_menu_make_popup_blob (local.get $hmenu)))
        (if (i32.eqz (global.get $menu_open_popup_blob))
          (then (return (i32.const 0))))
        (global.set $menu_open_hwnd  (local.get $hwnd))
        (global.set $menu_open_top   (i32.const 0))
        (global.set $menu_open_hover (i32.const -1))
        (global.set $menu_open_sub_hover (i32.const -1))
        (global.set $menu_open_x     (local.get $x))
        (global.set $menu_open_y     (local.get $y))
        (return (i32.const 1))))
    (if (global.get $menu_open_popup_blob)
      (then
        (call $heap_free (global.get $menu_open_popup_blob))
        (global.set $menu_open_popup_blob (i32.const 0))))
    (local.set $menu_id (i32.and (local.get $hmenu) (i32.const 0xFFFF)))
    (local.set $top_idx (i32.sub (i32.and (i32.shr_u (local.get $hmenu) (i32.const 16)) (i32.const 0xFFFF)) (i32.const 1)))
    (if (i32.or (i32.eqz (local.get $menu_id)) (i32.lt_s (local.get $top_idx) (i32.const 0)))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $menu_id) (global.get $last_load_menu_id))
      (then
        (call $push_rsrc_ctx (global.get $last_load_menu_hinst))
        (call $menu_load (local.get $hwnd) (local.get $menu_id))
        (call $pop_rsrc_ctx))
      (else
        (call $menu_load (local.get $hwnd) (local.get $menu_id))))
    (if (i32.eqz (call $menu_child_count (local.get $hwnd) (local.get $top_idx)))
      (then (return (i32.const 0))))
    (global.set $menu_open_hwnd  (local.get $hwnd))
    (global.set $menu_open_top   (local.get $top_idx))
    (global.set $menu_open_hover (i32.const -1))
    (global.set $menu_open_sub_hover (i32.const -1))
    (global.set $menu_open_x     (local.get $x))
    (global.set $menu_open_y     (local.get $y))
    (i32.const 1))

  (func (export "menu_track_popup_open_module")
        (param $hwnd i32) (param $hInstance i32) (param $menu_id i32) (param $top_idx i32) (param $x i32) (param $y i32)
        (result i32)
    (if (i32.or (i32.eqz (local.get $hwnd)) (i32.lt_s (local.get $top_idx) (i32.const 0)))
      (then (return (i32.const 0))))
    (if (global.get $menu_open_popup_blob)
      (then
        (call $heap_free (global.get $menu_open_popup_blob))
        (global.set $menu_open_popup_blob (i32.const 0))))
    (call $push_rsrc_ctx (local.get $hInstance))
    (call $menu_load (local.get $hwnd) (local.get $menu_id))
    (call $pop_rsrc_ctx)
    (if (i32.eqz (call $menu_child_count (local.get $hwnd) (local.get $top_idx)))
      (then (return (i32.const 0))))
    (global.set $menu_open_hwnd  (local.get $hwnd))
    (global.set $menu_open_top   (local.get $top_idx))
    (global.set $menu_open_hover (i32.const -1))
    (global.set $menu_open_sub_hover (i32.const -1))
    (global.set $menu_open_x     (local.get $x))
    (global.set $menu_open_y     (local.get $y))
    (i32.const 1))

  (func $menu_close (export "menu_close")
    (if (global.get $menu_open_popup_blob)
      (then
        (call $heap_free (global.get $menu_open_popup_blob))
        (global.set $menu_open_popup_blob (i32.const 0))))
    (global.set $menu_open_hwnd  (i32.const 0))
    (global.set $menu_open_top   (i32.const -1))
    (global.set $menu_open_hover (i32.const -1))
    (global.set $menu_open_sub_hover (i32.const -1))
    (global.set $menu_open_x     (i32.const -1))
    (global.set $menu_open_y     (i32.const -1)))

  (func (export "menu_set_hover") (param $cidx i32)
    (global.set $menu_open_hover (local.get $cidx))
    (global.set $menu_open_sub_hover (i32.const -1)))

  ;; Activate a top-level command item, if the bar slot is a command
  ;; instead of a popup. Returns 1 when a command was posted.
  (func $menu_activate_bar_command (export "menu_activate_bar_command")
        (param $hwnd i32) (param $top_idx i32) (result i32)
    (local $id i32)
    (if (call $menu_child_count (local.get $hwnd) (local.get $top_idx))
      (then (return (i32.const 0))))
    (local.set $id (call $menu_bar_id (local.get $hwnd) (local.get $top_idx)))
    (if (i32.eqz (local.get $id)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $id) (i32.const 28))
      (then (call $menu_post (local.get $hwnd) (i32.const 0x0010) (i32.const 0) (i32.const 0)))
      (else (call $menu_post (local.get $hwnd) (i32.const 0x0111) (local.get $id) (i32.const 0))))
    (call $menu_close)
    (i32.const 1))

  ;; USER-side click routing for an already-open dropdown. The host supplies
  ;; only the browser/screen point; WAT owns menu hit testing, hover, command
  ;; activation, and close/switch behavior.
  (func $menu_handle_mouse_open (export "menu_handle_mouse_open")
        (param $sx i32) (param $sy i32) (result i32)
    (local $hwnd i32) (local $top i32)
    (local $bar_x i32) (local $bar_y i32) (local $bar_h i32)
    (local $dx i32) (local $dy i32) (local $idx i32)
    (local $sdx i32) (local $sdy i32)
    (local.set $hwnd (global.get $menu_open_hwnd))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $top (global.get $menu_open_top))
    (local.set $bar_x (call $menu_bar_screen_x (local.get $hwnd)))
    (local.set $bar_y (call $menu_bar_screen_y (local.get $hwnd)))
    (local.set $bar_h (call $menu_bar_screen_h))
    (local.set $dx (call $menu_dropdown_x (local.get $hwnd) (local.get $top)))
    (local.set $dy (call $menu_dropdown_y (local.get $hwnd)))

    (local.set $idx (call $menu_hittest_dropdown
      (local.get $hwnd) (local.get $top)
      (local.get $dx) (local.get $dy)
      (local.get $sx) (local.get $sy)))
    (if (i32.ge_s (local.get $idx) (i32.const 0))
      (then
        (global.set $menu_open_hover (local.get $idx))
        (global.set $menu_open_sub_hover (i32.const -1))
        (drop (call $menu_activate))
        (return (i32.const 1))))

    (if (i32.ge_s (global.get $menu_open_hover) (i32.const 0))
      (then
        (local.set $sdx (i32.add (local.get $dx) (i32.const 180)))
        (local.set $sdy
          (i32.add (i32.add (local.get $dy) (i32.const 2))
                   (i32.mul (global.get $menu_open_hover) (i32.const 20))))
        (local.set $idx (call $menu_hittest_submenu
          (local.get $hwnd) (local.get $top) (global.get $menu_open_hover)
          (local.get $sdx) (local.get $sdy)
          (local.get $sx) (local.get $sy)))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then
            (global.set $menu_open_sub_hover (local.get $idx))
            (drop (call $menu_activate))
            (return (i32.const 1))))))

    ;; TrackPopupMenu popups have an explicit screen anchor. They are not a
    ;; menubar tracking session, so an outside click must dismiss them instead
    ;; of switching to another top-level menu item in the same resource.
    (if (i32.lt_s (global.get $menu_open_x) (i32.const 0))
      (then
        (local.set $idx (call $menu_hittest_bar
          (local.get $hwnd) (local.get $bar_x) (local.get $bar_y)
          (local.get $sx) (local.get $sy)))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then
            (if (call $menu_activate_bar_command (local.get $hwnd) (local.get $idx))
              (then (return (i32.const 1))))
            (call $menu_open (local.get $hwnd) (local.get $idx))
            (return (i32.const 1))))))

    (call $menu_close)
    (i32.const 1))

  ;; Hover update for an open dropdown. Returns the resulting hover index
  ;; (or -1) after updating WAT tracking state.
  (func $menu_hover_from_point (export "menu_hover_from_point")
        (param $sx i32) (param $sy i32) (result i32)
    (local $hwnd i32) (local $top i32)
    (local $bar_x i32) (local $bar_y i32) (local $bar_h i32)
    (local $dx i32) (local $dy i32) (local $idx i32)
    (local $sdx i32) (local $sdy i32) (local $subn i32)
    (local.set $hwnd (global.get $menu_open_hwnd))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const -1))))
    (local.set $top (global.get $menu_open_top))
    (local.set $bar_x (call $menu_bar_screen_x (local.get $hwnd)))
    (local.set $bar_y (call $menu_bar_screen_y (local.get $hwnd)))
    (local.set $bar_h (call $menu_bar_screen_h))
    (local.set $dx (call $menu_dropdown_x (local.get $hwnd) (local.get $top)))
    (local.set $dy (call $menu_dropdown_y (local.get $hwnd)))
    ;; When a cascading submenu is open, prefer the submenu tracking region
    ;; over lower parent rows on the right side of the dropdown. Otherwise a
    ;; diagonal move toward "2 Players" can briefly hit "&Sounds" and close
    ;; the cascade before the cursor reaches the child menu.
    (if (i32.ge_s (global.get $menu_open_hover) (i32.const 0))
      (then
        (local.set $subn (call $menu_child_sub_count
          (local.get $hwnd) (local.get $top) (global.get $menu_open_hover)))
        (if (i32.gt_s (local.get $subn) (i32.const 0))
          (then
            (local.set $sdx (i32.add (local.get $dx) (i32.const 180)))
            (local.set $sdy
              (i32.add (i32.add (local.get $dy) (i32.const 2))
                       (i32.mul (global.get $menu_open_hover) (i32.const 20))))
            (local.set $idx
              (i32.and
                (i32.and
                  (i32.ge_s (local.get $sx) (i32.add (local.get $dx) (i32.const 120)))
                  (i32.lt_s (local.get $sx) (i32.add (local.get $sdx) (i32.const 178))))
                (i32.and
                  (i32.ge_s (local.get $sy) (local.get $sdy))
                  (i32.lt_s (local.get $sy)
                    (i32.add (local.get $sdy)
                      (i32.add (i32.mul (local.get $subn) (i32.const 20))
                               (i32.const 4)))))))
            (if (local.get $idx)
              (then
                (local.set $idx (call $menu_hittest_submenu
                  (local.get $hwnd) (local.get $top) (global.get $menu_open_hover)
                  (local.get $sdx) (local.get $sdy)
                  (local.get $sx) (local.get $sy)))
                (if (i32.ge_s (local.get $idx) (i32.const 0))
                  (then (global.set $menu_open_sub_hover (local.get $idx))))
                (return (global.get $menu_open_hover))))))))
    (local.set $idx (call $menu_hittest_dropdown
      (local.get $hwnd) (local.get $top)
      (local.get $dx) (local.get $dy)
      (local.get $sx) (local.get $sy)))
    (if (i32.ge_s (local.get $idx) (i32.const 0))
      (then
        (global.set $menu_open_hover (local.get $idx))
        (global.set $menu_open_sub_hover (i32.const -1))
        (return (local.get $idx))))
    (if (i32.ge_s (global.get $menu_open_hover) (i32.const 0))
      (then
        (local.set $sdx (i32.add (local.get $dx) (i32.const 180)))
        (local.set $sdy
          (i32.add (i32.add (local.get $dy) (i32.const 2))
                   (i32.mul (global.get $menu_open_hover) (i32.const 20))))
        (local.set $idx (call $menu_hittest_submenu
          (local.get $hwnd) (local.get $top) (global.get $menu_open_hover)
          (local.get $sdx) (local.get $sdy)
          (local.get $sx) (local.get $sy)))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then
            (global.set $menu_open_sub_hover (local.get $idx))
            (return (global.get $menu_open_hover))))
        ;; Keep the parent submenu open while the pointer crosses the small
        ;; non-client gap between the parent item and its cascading submenu.
        (local.set $subn (call $menu_child_sub_count
          (local.get $hwnd) (local.get $top) (global.get $menu_open_hover)))
        (local.set $idx
          (i32.and
            (i32.gt_s (local.get $subn) (i32.const 0))
            (i32.and
              (i32.and
                (i32.ge_s (local.get $sx) (i32.add (local.get $dx) (i32.const 178)))
                (i32.lt_s (local.get $sx) (i32.add (local.get $sdx) (i32.const 178))))
              (i32.and
                (i32.ge_s (local.get $sy) (local.get $sdy))
                (i32.lt_s (local.get $sy)
                  (i32.add (local.get $sdy)
                    (i32.add (i32.mul (local.get $subn) (i32.const 20))
                             (i32.const 4))))))))
        (if (local.get $idx)
          (then (return (global.get $menu_open_hover))))))
    (global.set $menu_open_hover (i32.const -1))
    (global.set $menu_open_sub_hover (i32.const -1))
    (i32.const -1))

  ;; Open a top-level menu item for a particular hwnd and point. Used by the
  ;; browser event shell after it has already selected the top-level window.
  (func $menu_handle_bar_click (export "menu_handle_bar_click")
        (param $hwnd i32) (param $sx i32) (param $sy i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $menu_hittest_bar
      (local.get $hwnd)
      (call $menu_bar_screen_x (local.get $hwnd))
      (call $menu_bar_screen_y (local.get $hwnd))
      (local.get $sx) (local.get $sy)))
    (if (i32.lt_s (local.get $idx) (i32.const 0)) (then (return (i32.const 0))))
    (if (call $menu_activate_bar_command (local.get $hwnd) (local.get $idx))
      (then (return (i32.const 1))))
    (call $menu_open (local.get $hwnd) (local.get $idx))
    (i32.const 1))

  ;; Down/Up arrow nav: walk to next selectable child, wrapping. $dir
  ;; is +1 (Down) or -1 (Up).
  (func $menu_advance (export "menu_advance") (param $dir i32)
    (local $n i32) (local $i i32) (local $k i32) (local $f i32)
    (local.set $n (call $menu_track_child_count))
    (if (i32.eqz (local.get $n)) (then (return)))
    (local.set $i (global.get $menu_open_hover))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (local.set $i (select (i32.const -1) (local.get $n)
                                  (i32.gt_s (local.get $dir) (i32.const 0))))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
      (local.set $i (i32.add (local.get $i) (local.get $dir)))
      (if (i32.lt_s (local.get $i) (i32.const 0))
        (then (local.set $i (i32.sub (local.get $n) (i32.const 1)))))
      (if (i32.ge_s (local.get $i) (local.get $n))
        (then (local.set $i (i32.const 0))))
      (local.set $f (call $menu_child_flags
                     (global.get $menu_open_hwnd)
                     (global.get $menu_open_top)
                     (local.get $i)))
      (if (i32.eqz (i32.and (local.get $f) (i32.const 0x03)))
        (then
          (global.set $menu_open_hover (local.get $i))
          (global.set $menu_open_sub_hover (i32.const -1))
          (return)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $scan))))

  (func $menu_sub_advance (param $dir i32)
    (local $n i32) (local $i i32) (local $k i32) (local $f i32)
    (local.set $n (call $menu_sub_track_child_count))
    (if (i32.eqz (local.get $n)) (then (return)))
    (local.set $i (global.get $menu_open_sub_hover))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (local.set $i (select (i32.const -1) (local.get $n)
                                  (i32.gt_s (local.get $dir) (i32.const 0))))))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
      (local.set $i (i32.add (local.get $i) (local.get $dir)))
      (if (i32.lt_s (local.get $i) (i32.const 0))
        (then (local.set $i (i32.sub (local.get $n) (i32.const 1)))))
      (if (i32.ge_s (local.get $i) (local.get $n))
        (then (local.set $i (i32.const 0))))
      (local.set $f (call $menu_subchild_flags
        (global.get $menu_open_hwnd)
        (global.get $menu_open_top)
        (global.get $menu_open_hover)
        (local.get $i)))
      (if (i32.eqz (i32.and (local.get $f) (i32.const 0x03)))
        (then
          (global.set $menu_open_sub_hover (local.get $i))
          (return)))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $scan))))

  ;; Left/Right arrow nav: switch to neighbor bar item, wrapping.
  (func $menu_switch_top (export "menu_switch_top") (param $dir i32)
    (local $n i32) (local $i i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return)))
    (local.set $n (call $menu_bar_count (global.get $menu_open_hwnd)))
    (if (i32.eqz (local.get $n)) (then (return)))
    (local.set $i (i32.add (global.get $menu_open_top) (local.get $dir)))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (local.set $i (i32.sub (local.get $n) (i32.const 1)))))
    (if (i32.ge_s (local.get $i) (local.get $n))
      (then (local.set $i (i32.const 0))))
    (global.set $menu_open_top (local.get $i))
    (global.set $menu_open_hover (i32.const -1))
    (global.set $menu_open_sub_hover (i32.const -1))
    (global.set $menu_open_x     (i32.const -1))
    (global.set $menu_open_y     (i32.const -1)))

  ;; Keyboard routing for an already-open dropdown. Returns 1 when the key was
  ;; consumed by USER menu tracking.
  (func $menu_handle_key_open (export "menu_handle_key_open")
        (param $vk i32) (result i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $vk) (i32.const 27))
      (then (call $menu_close) (return (i32.const 1))))     ;; Escape
    (if (i32.eq (local.get $vk) (i32.const 40))
      (then
        (if (i32.ge_s (global.get $menu_open_sub_hover) (i32.const 0))
          (then (call $menu_sub_advance (i32.const 1)))
          (else (call $menu_advance (i32.const 1))))
        (return (i32.const 1))))  ;; Down
    (if (i32.eq (local.get $vk) (i32.const 38))
      (then
        (if (i32.ge_s (global.get $menu_open_sub_hover) (i32.const 0))
          (then (call $menu_sub_advance (i32.const -1)))
          (else (call $menu_advance (i32.const -1))))
        (return (i32.const 1)))) ;; Up
    (if (i32.eq (local.get $vk) (i32.const 39))
      (then
        (if (call $menu_sub_track_child_count)
          (then
            (global.set $menu_open_sub_hover (call $menu_sub_first_selectable)))
          (else
            (if (i32.lt_s (global.get $menu_open_x) (i32.const 0))
              (then (call $menu_switch_top (i32.const 1))))))
        (return (i32.const 1))))  ;; Right
    (if (i32.eq (local.get $vk) (i32.const 37))
      (then
        (if (i32.ge_s (global.get $menu_open_sub_hover) (i32.const 0))
          (then (global.set $menu_open_sub_hover (i32.const -1)))
          (else
            (if (i32.lt_s (global.get $menu_open_x) (i32.const 0))
              (then (call $menu_switch_top (i32.const -1))))))
        (return (i32.const 1)))) ;; Left
    (if (i32.eq (local.get $vk) (i32.const 13))
      (then (drop (call $menu_activate)) (return (i32.const 1)))) ;; Enter
    (if (i32.and
          (i32.ge_s (local.get $vk) (i32.const 65))
          (i32.le_s (local.get $vk) (i32.const 90)))
      (then
        (if (call $menu_handle_letter (local.get $vk))
          (then (return (i32.const 1))))))
    (i32.const 0))

  ;; Internal: enqueue a posted message for hwnd. Mirrors the body of
  ;; $handle_PostMessageA. Used by $menu_post_command on activation.
  (func $menu_post (param $hwnd i32) (param $msg i32)
                    (param $wp i32) (param $lp i32)
    (local $tmp i32)
    (if (i32.ge_u (global.get $post_queue_count) (i32.const 64)) (then (return)))
    (local.set $tmp (i32.add (i32.const 0x400)
                      (i32.mul (global.get $post_queue_count) (i32.const 16))))
    (i32.store           (local.get $tmp) (local.get $hwnd))
    (i32.store offset=4  (local.get $tmp) (local.get $msg))
    (i32.store offset=8  (local.get $tmp) (local.get $wp))
    (i32.store offset=12 (local.get $tmp) (local.get $lp))
    (global.set $post_queue_count (i32.add (global.get $post_queue_count) (i32.const 1))))

  ;; Activate the currently-hovered child of the open menu. Posts a
  ;; WM_COMMAND (or WM_CLOSE for the File→Exit id=28 special case)
  ;; to the parent hwnd, then closes the menu. Returns the command
  ;; id that was posted (0 if nothing happened).
  (func $menu_activate (export "menu_activate") (result i32)
    (local $hwnd i32) (local $top i32) (local $hover i32)
    (local $sub i32) (local $f i32) (local $id i32)
    (local.set $hwnd (global.get $menu_open_hwnd))
    (if (i32.eqz (local.get $hwnd)) (then (return (i32.const 0))))
    (local.set $top  (global.get $menu_open_top))
    (local.set $hover (global.get $menu_open_hover))
    (if (i32.lt_s (local.get $hover) (i32.const 0)) (then (return (i32.const 0))))
    (local.set $f (call $menu_child_flags (local.get $hwnd) (local.get $top) (local.get $hover)))
    (if (i32.and (local.get $f) (i32.const 0x03))
      (then (return (i32.const 0))))   ;; separator or grayed
    (if (call $menu_child_sub_count (local.get $hwnd) (local.get $top) (local.get $hover))
      (then
        (local.set $sub (global.get $menu_open_sub_hover))
        (if (i32.lt_s (local.get $sub) (i32.const 0)) (then (return (i32.const 0))))
        (local.set $f (call $menu_subchild_flags
                        (local.get $hwnd) (local.get $top) (local.get $hover) (local.get $sub)))
        (if (i32.and (local.get $f) (i32.const 0x03))
          (then (return (i32.const 0))))
        (local.set $id (call $menu_subchild_id
                         (local.get $hwnd) (local.get $top) (local.get $hover) (local.get $sub)))
        (if (call $menu_try_edit_command (local.get $id))
          (then (nop))
          (else (if (i32.eq (local.get $id) (i32.const 28))
            (then (call $menu_post (local.get $hwnd) (i32.const 0x0010) (i32.const 0) (i32.const 0)))
            (else (call $menu_post (local.get $hwnd) (i32.const 0x0111) (local.get $id) (i32.const 0))))))
        (call $menu_close)
        (return (local.get $id))))
    (local.set $id (call $menu_child_id (local.get $hwnd) (local.get $top) (local.get $hover)))
    (if (call $menu_try_edit_command (local.get $id))
      (then (nop))
      (else (if (i32.eq (local.get $id) (i32.const 28))
      (then (call $menu_post (local.get $hwnd) (i32.const 0x0010) (i32.const 0) (i32.const 0)))
      (else (call $menu_post (local.get $hwnd) (i32.const 0x0111) (local.get $id) (i32.const 0))))))
    (call $menu_close)
    (local.get $id))

  ;; Find the bar item index whose accelerator char (uppercase ASCII)
  ;; matches $ch, or -1.
  (func $menu_find_bar_accel (export "menu_find_bar_accel") (param $hwnd i32) (param $ch i32) (result i32)
    (local $n i32) (local $i i32)
    (local.set $n (call $menu_bar_count (local.get $hwnd)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (if (i32.eq (call $menu_bar_accel (local.get $hwnd) (local.get $i)) (local.get $ch))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Open the first suitable top-level menu with a matching bar accelerator.
  ;; Prefer the focused window's top-level ancestor, then scan WND_RECORDS in
  ;; reverse slot order as the current z-order proxy.
  (func $menu_open_bar_accel (export "menu_open_bar_accel")
        (param $ch i32) (result i32)
    (local $hwnd i32) (local $idx i32) (local $slot i32) (local $rec i32)
    (local $style i32)
    (if (global.get $focus_hwnd)
      (then
        (local.set $hwnd (call $wnd_top_level (global.get $focus_hwnd)))
        (local.set $idx (call $menu_find_bar_accel (local.get $hwnd) (local.get $ch)))
        (if (i32.ge_s (local.get $idx) (i32.const 0))
          (then
            (if (call $menu_activate_bar_command (local.get $hwnd) (local.get $idx))
              (then (return (i32.const 1))))
            (call $menu_open (local.get $hwnd) (local.get $idx))
            (return (i32.const 1))))))
    (local.set $slot (i32.sub (global.get $MAX_WINDOWS) (i32.const 1)))
    (block $done (loop $scan
      (local.set $rec (call $wnd_record_addr (local.get $slot)))
      (local.set $hwnd (i32.load (local.get $rec)))
      (if (local.get $hwnd)
        (then
          (local.set $style (call $wnd_get_style (local.get $hwnd)))
          (if (i32.and
                (i32.and
                  (i32.ne (i32.and (local.get $style) (i32.const 0x10000000)) (i32.const 0))
                  (i32.eqz (i32.and (local.get $style) (i32.const 0x40000000))))
                (i32.eq (call $wnd_top_level (local.get $hwnd)) (local.get $hwnd)))
            (then
              (local.set $idx (call $menu_find_bar_accel
                (local.get $hwnd) (local.get $ch)))
              (if (i32.ge_s (local.get $idx) (i32.const 0))
                (then
                  (if (call $menu_activate_bar_command (local.get $hwnd) (local.get $idx))
                    (then (return (i32.const 1))))
                  (call $menu_open (local.get $hwnd) (local.get $idx))
                  (return (i32.const 1))))))))
      (br_if $done (i32.eqz (local.get $slot)))
      (local.set $slot (i32.sub (local.get $slot) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; Try to activate by child accelerator char while a menu is open.
  ;; Returns 1 if a matching item was found and activated, else 0.
  (func $menu_handle_letter (export "menu_handle_letter") (param $ch i32) (result i32)
    (local $n i32) (local $i i32) (local $f i32)
    (if (i32.eqz (global.get $menu_open_hwnd)) (then (return (i32.const 0))))
    (local.set $n (call $menu_track_child_count))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $f (call $menu_child_flags
                     (global.get $menu_open_hwnd)
                     (global.get $menu_open_top)
                     (local.get $i)))
      (if (i32.eqz (i32.and (local.get $f) (i32.const 0x03)))
        (then
          (if (i32.eq (call $menu_child_accel
                       (global.get $menu_open_hwnd)
                       (global.get $menu_open_top)
                       (local.get $i))
                      (local.get $ch))
            (then
              (global.set $menu_open_hover (local.get $i))
              (drop (call $menu_activate))
              (return (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; ============================================================
  ;; MENU API HANDLERS
  ;; The 35 $handle_* entry points for the menu APIs, moved here from
  ;; 09a-handlers.wat where they were scattered across a dozen places. This file
  ;; already held the 75 menu_* helpers they call and had no entry points of its
  ;; own.
  ;; ============================================================

  ;; 84: DestroyMenu(hMenu) — 1 arg stdcall, return TRUE
  (func $handle_DestroyMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (call $dynamic_menu_destroy (local.get $arg0))
      (then (global.set $eax (i32.const 1)))
      (else (global.set $eax (call $host_menu_destroy (local.get $arg0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 87: GetMenu(hwnd) — return the attached menu's stable resource key.
  (func $handle_GetMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Named class menus use a guest string pointer rather than a low-word
    ;; resource ID. Preserve that identity so SetMenu can reattach the menu
    ;; after an app temporarily removes it (Pinball fullscreen). menu_set's
    ;; legacy host blobs have no source key, so retain the old fake fallback.
    (global.set $eax (call $menu_source_get (local.get $arg0)))
    (if (i32.and
          (i32.eqz (global.get $eax))
          (i32.gt_s (call $menu_bar_count (local.get $arg0)) (i32.const 0)))
      (then (global.set $eax (i32.const 0x80001))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 88: GetSubMenu(hMenu, nPos) → HMENU
  ;; Returns submenu handle at position nPos. Encode as hMenu | (pos << 16).
  (func $handle_GetSubMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.or
      (i32.and (local.get $arg0) (i32.const 0xFFFF))
      (i32.shl (i32.add (local.get $arg1) (i32.const 1)) (i32.const 16))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; 314: GetSystemMenu(hwnd, bRevert) — stdcall(2)
  (func $handle_GetSystemMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x40003))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))) (return)
  )

  ;; 113: EnableMenuItem(hMenu, uIDEnableItem, uEnable).
  ;; EnableMenuItem(hMenu, uIDEnableItem, uEnable). MF_BYPOSITION is 0x400 and
  ;; has to be honoured: it is how MFC addresses items while walking a popup,
  ;; and treating a position as a command id put the state on the wrong item.
  (func $handle_EnableMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (i32.and (local.get $arg2) (i32.const 0x400))
        (then (call $menu_enable_position_global
          (local.get $arg0) (local.get $arg1)
          (i32.ne (i32.and (local.get $arg2) (i32.const 3)) (i32.const 0))))
        (else (call $menu_enable_item_global
          (local.get $arg0) (local.get $arg1) (local.get $arg2)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 121: CheckMenuRadioItem(hMenu, idFirst, idLast, idCheck, uFlags)
  ;; Unchecks items [idFirst..idLast], checks idCheck with radio bullet. Returns TRUE.
  ;; Menu item state is tracked in the renderer's menu model when available.
  (func $handle_CheckMenuRadioItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $menu_check_radio_global
      (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; 122: CheckMenuItem(hMenu, uIDCheckItem, uCheck) → previous state
  ;; We don't track HMENU-to-window mapping directly, so walk every
  ;; window with a menu blob and toggle the first matching command id.
  ;; uCheck combines MF_BYCOMMAND/MF_BYPOSITION with MF_CHECKED (8) or
  ;; MF_UNCHECKED (0); MF_BYPOSITION isn't supported here — in practice
  ;; callers use MF_BYCOMMAND, which is what our id-based walk matches.
  (func $handle_CheckMenuItem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (i32.and (local.get $arg2) (i32.const 0x400))
      (then (global.set $eax (call $menu_check_position_global
        (local.get $arg0) (local.get $arg1)
        (i32.and (local.get $arg2) (i32.const 8)))))
      (else (global.set $eax (call $menu_check_item_global
        (local.get $arg1)
        (i32.and (local.get $arg2) (i32.const 8))))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 137: LoadMenuA(hInstance, lpMenuName) — 2 args stdcall
  ;; Return menu resource ID as handle (host renderer resolves by ID)
  (func $handle_LoadMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; If lpMenuName < 0x10000, it's MAKEINTRESOURCE (resource ID)
    (if (i32.lt_u (local.get $arg1) (i32.const 0x10000))
      (then
        (global.set $last_load_menu_id (i32.and (local.get $arg1) (i32.const 0xFFFF)))
        (global.set $last_load_menu_hinst (local.get $arg0))
        (global.set $eax (i32.or (local.get $arg1) (i32.const 0x00BE0000))))
      (else (global.set $eax (i32.const 0x00BE0001))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
  )

  ;; 138: TrackPopupMenuEx(hMenu, uFlags, x, y, hWnd, lptpm)
  (func $handle_TrackPopupMenuEx (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $menu_track_popup_open
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
  )

  ;; 292: LoadMenuW — a menu is named by ordinal here (the menu itself comes
  ;; from the PE resource), and an ordinal has no encoding, so this is
  ;; LoadMenuA.
  (func $handle_LoadMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_LoadMenuA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 407: RemoveMenu(hMenu, uPosition, uFlags) — return TRUE.
  ;; AppendMenuA/InsertMenuA are no-ops in this build (the menu bar is parsed
  ;; from the PE resource), so RemoveMenu has nothing real to remove either.
  (func $handle_RemoveMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; IsMenu(hMenu) → BOOL.
  (func $handle_IsMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $menu_handle_is_valid (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))
  )

  ;; 619: TrackPopupMenu(hMenu, uFlags, x, y, nReserved, hWnd, prcRect)
  (func $handle_TrackPopupMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa_esp i32) (local $hwnd i32)
    (local.set $wa_esp (call $g2w (global.get $esp)))
    (local.set $hwnd (i32.load (i32.add (local.get $wa_esp) (i32.const 24))))
    (global.set $eax (call $menu_track_popup_open
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $hwnd)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32)))
  )

  ;; 620: GetMenuItemID — STUB: unimplemented
  ;; GetMenuItemID(hMenu, nPos) — 0 for a separator or a submenu, which is
  ;; what Windows answers and what MFC's update loop expects to skip on.
  (func $handle_GetMenuItemID (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $menu_handle_item_id (local.get $arg0) (local.get $arg1)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))  ;; 2 args
  )

  ;; SetMenuItemInfoA(hMenu, uItem, fByPos, lpmii) — no-op; menu subsystem
  ;; is a stub. flip2d calls this during window setup but doesn't depend on it.
  (func $handle_SetMenuItemInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) ;; 4 args
  )

  ;; GetMenuItemInfoA(hMenu, uItem, fByPos, lpmii) — no-op; zero the struct
  ;; past its dwSize (caller-provided at +0) so callers don't see garbage.
  (func $handle_GetMenuItemInfoA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) ;; 4 args
  )

  ;; 621: GetMenuItemCount(hMenu) — the menu subsystem is a stub that doesn't
  ;; track items, so report 0 (empty menu) rather than crashing. DX samples
  ;; like flip2d call this during window setup but don't care about the count.
  ;; GetMenuItemCount(hMenu). Returning 0 here is what kept every MFC menu
  ;; stale: CFrameWnd::OnInitMenuPopup walks the popup by index to run its
  ;; ON_UPDATE_COMMAND_UI handlers, and a count of zero means it walks nothing
  ;; and never enables or greys anything. Paint offered File > Send... in black
  ;; on a machine with no mail subsystem because of this.
  (func $handle_GetMenuItemCount (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $menu_handle_item_count (local.get $arg0)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))) ;; 1 arg stdcall
  )

  ;; 650: DrawMenuBar — STUB: unimplemented
  (func $handle_DrawMenuBar (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; DrawMenuBar(hwnd) → BOOL. Redraws menu bar — host renderer handles menus, just return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))  ;; stdcall, 1 arg
  )

  ;; 655: AppendMenuW(hMenu, uFlags, uIDNewItem, lpNewItem)
  (func $handle_AppendMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dyn i32)
    (local.set $dyn
      (call $dynamic_menu_append
        (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (if (i32.ne (local.get $dyn) (i32.const -1))
      (then (global.set $eax (local.get $dyn)))
      (else
        (global.set $eax (call $host_menu_append
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (call $g2w (local.get $arg3)) (i32.const 1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; AppendMenuA(hMenu, uFlags, uIDNewItem, lpNewItem) — return TRUE
  (func $handle_AppendMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dyn i32)
    (local.set $dyn
      (call $dynamic_menu_append
        (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3)))
    (if (i32.ne (local.get $dyn) (i32.const -1))
      (then (global.set $eax (local.get $dyn)))
      (else
        (global.set $eax (call $host_menu_append
          (local.get $arg0) (local.get $arg1) (local.get $arg2) (call $g2w (local.get $arg3)) (i32.const 0)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  ;; InsertMenuA(hMenu, uPosition, uFlags, uIDNewItem, lpNewItem)
  ;; MF_BYPOSITION is 0x400; without it uPosition names the item to insert
  ;; before by command id. Resource-backed menu blobs are not mutable yet, so
  ;; those handles keep reporting success as they always have.
  (func $handle_InsertMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dyn i32)
    (local.set $dyn
      (call $dynamic_menu_insert
        (local.get $arg0)
        (call $dynamic_menu_resolve_pos (local.get $arg0) (local.get $arg1)
          (i32.and (local.get $arg2) (i32.const 0x400)))
        (local.get $arg2) (local.get $arg3) (local.get $arg4)
        ;; MF_POPUP: uIDNewItem is the submenu handle, not a command id.
        (if (result i32) (i32.and (local.get $arg2) (i32.const 0x10))
          (then (local.get $arg3))
          (else (i32.const 0)))))
    (global.set $eax
      (if (result i32) (i32.eq (local.get $dyn) (i32.const -1))
        (then (i32.const 1))
        (else (local.get $dyn))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; InsertMenuItemA/W(hMenu, uItem, fByPosition, lpmii)
  (func $handle_InsertMenuItemA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dyn i32) (local $flags i32)
    (local.set $flags (call $menu_item_info_decode (local.get $arg3)))
    (local.set $dyn
      (call $dynamic_menu_insert
        (local.get $arg0)
        (call $dynamic_menu_resolve_pos (local.get $arg0) (local.get $arg1) (local.get $arg2))
        (local.get $flags) (global.get $mii_out_id) (global.get $mii_out_data)
        (global.get $mii_out_submenu)))
    (global.set $eax
      (if (result i32) (i32.eq (local.get $dyn) (i32.const -1))
        (then (i32.const 1))
        (else (local.get $dyn))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
  )

  (func $handle_InsertMenuItemW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_InsertMenuItemA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; ModifyMenuA(hMnu, uPosition, uFlags, uIDNewItem, lpNewItem) — return TRUE
  (func $handle_ModifyMenuA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
  )

  ;; 656: DeleteMenu — STUB: unimplemented
  (func $handle_DeleteMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; DeleteMenu(hMenu, uPosition, uFlags) — return TRUE
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
  )

  ;; 672: SetMenuItemBitmaps — STUB: unimplemented
  (func $handle_SetMenuItemBitmaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 673: ModifyMenuW — STUB: unimplemented
  (func $handle_ModifyMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $handle_ModifyMenuA
      (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; 674: GetMenuState — STUB: unimplemented
  ;; GetMenuState(hMenu, uId, uFlags) → MF_* state, or -1 when the item is not
  ;; there. MF_BYPOSITION is 0x400; without it uId is a command id.
  (func $handle_GetMenuState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax
      (if (result i32) (i32.and (local.get $arg2) (i32.const 0x400))
        (then (call $menu_handle_item_state (local.get $arg0) (local.get $arg1)))
        (else (call $menu_handle_state_by_id (local.get $arg0) (local.get $arg1)))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))  ;; 3 args
  )

  ;; 735: GetMenuItemRect(hWnd, hMenu, uItem, lprcItem) -> BOOL
  (func $handle_GetMenuItemRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $rect_wasm i32)
    ;; arg0=hWnd, arg1=hMenu, arg2=uItem, arg3=lprcItem
    (local.set $rect_wasm (call $g2w (local.get $arg3)))
    ;; Fill RECT with reasonable defaults per menu item
    (i32.store (local.get $rect_wasm)
      (i32.mul (local.get $arg2) (i32.const 100))) ;; left
    (i32.store (i32.add (local.get $rect_wasm) (i32.const 4))
      (i32.const 0)) ;; top
    (i32.store (i32.add (local.get $rect_wasm) (i32.const 8))
      (i32.add (i32.mul (local.get $arg2) (i32.const 100)) (i32.const 100))) ;; right
    (i32.store (i32.add (local.get $rect_wasm) (i32.const 12))
      (i32.const 20)) ;; bottom
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))) ;; stdcall 4 params + ret
  )

  ;; 675: GetMenuCheckMarkDimensions — STUB: unimplemented
  (func $handle_GetMenuCheckMarkDimensions (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr))
  )

  ;; 682: InsertMenuW(hMenu, uPosition, uFlags, uIDNewItem, lpNewItem).
  ;; This reported success and inserted nothing, so a wide app's menu was
  ;; missing exactly the items it built at runtime. Narrow the label and let
  ;; the A implementation do the insert.
  ;;
  ;; The narrowed copy is deliberately not freed: the menu record keeps the
  ;; label pointer, so it has to outlive this call the same way the caller's
  ;; own string does. MF_BITMAP (0x04) and MF_OWNERDRAW (0x100) make lpNewItem
  ;; a handle rather than a string — those pass through untouched.
  (func $handle_InsertMenuW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $len i32) (local $ansi i32)
    (if (i32.and
          (i32.ne (local.get $arg4) (i32.const 0))
          (i32.eqz (i32.and (local.get $arg2) (i32.const 0x104))))
      (then
        (local.set $len (i32.add (call $guest_wcslen (local.get $arg4)) (i32.const 1)))
        (local.set $ansi (call $heap_alloc (local.get $len)))
        (if (local.get $ansi)
          (then
            (drop (call $wide_to_ansi (local.get $arg4) (local.get $ansi) (local.get $len)))
            (local.set $arg4 (local.get $ansi))))))
    (call $handle_InsertMenuA (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $arg4) (local.get $name_ptr))
  )

  ;; GetMenuStringA(hMenu, uIDItem, lpString, cchMax, uFlag) → chars copied.
  ;; MFC reads every label back while walking a popup, so this sits directly
  ;; behind the WM_INITMENUPOPUP path -- it was not registered at all, and the
  ;; unimplemented-API crash was the first thing Paint hit once its update loop
  ;; started running. MF_BYPOSITION is 0x400.
  (func $handle_GetMenuStringA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $menu_handle_copy_label
      (local.get $arg0) (local.get $arg1)
      (i32.and (local.get $arg4) (i32.const 0x400))
      (if (result i32) (local.get $arg2) (then (call $g2w (local.get $arg2))) (else (i32.const 0)))
      (local.get $arg3)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; 5 args
  )

  ;; 683: GetMenuStringW(hMenu, uIDItem, lpString, cchMax, uFlag) → chars copied.
  ;; The label lives as ANSI, so read it into a staging buffer of the caller's
  ;; size and widen it into their buffer. A NULL buffer is a measuring call and
  ;; needs no staging at all.
  (func $handle_GetMenuStringW (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $tmp i32) (local $len i32)
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))  ;; 5 args
    (if (i32.or (i32.eqz (local.get $arg2)) (i32.le_s (local.get $arg3) (i32.const 0)))
      (then
        (global.set $eax (call $menu_handle_copy_label
          (local.get $arg0) (local.get $arg1)
          (i32.and (local.get $arg4) (i32.const 0x400))
          (i32.const 0) (local.get $arg3)))
        (return)))
    (local.set $tmp (call $heap_alloc (local.get $arg3)))
    (if (i32.eqz (local.get $tmp))
      (then (call $gs16 (local.get $arg2) (i32.const 0))
            (global.set $eax (i32.const 0)) (return)))
    (call $gs8 (local.get $tmp) (i32.const 0))
    (local.set $len (call $menu_handle_copy_label
      (local.get $arg0) (local.get $arg1)
      (i32.and (local.get $arg4) (i32.const 0x400))
      (call $g2w (local.get $tmp)) (local.get $arg3)))
    (drop (call $ansi_to_wide (local.get $tmp) (local.get $arg2) (local.get $arg3)))
    (call $heap_free (local.get $tmp))
    (global.set $eax (local.get $len))
  )

  ;; 687: CreateMenu() — allocate opaque HMENU. No backing state: AppendMenu/InsertMenu
  ;; are already no-ops, menu bars render from PE RT_MENU resources, and DestroyMenu is
  ;; a return-TRUE no-op. The handle just needs to be non-zero and distinguishable so
  ;; downstream APIs that validate it won't trip.
  (func $handle_CreateMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $host_menu_create))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )

  ;; CreatePopupMenu() — WAT-owned dynamic popup menu state.
  (func $handle_CreatePopupMenu (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $dynamic_menu_create))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
  )
