  ;; ============================================================
  ;; WAT-NATIVE TREEVIEW CONTROL
  ;; ============================================================
  ;; Memory layout at TV_TABLE (0x9000), 32 items × 32 bytes = 1024B
  ;; Per item (32 bytes):
  ;;   +0:  handle      (0 = free slot, else 0xCC000001+)
  ;;   +4:  parent      (HTREEITEM or 0 for root)
  ;;   +8:  firstChild
  ;;   +12: nextSib
  ;;   +16: prevSib
  ;;   +20: state       (checkbox bits 12-15: 0x2000=checked)
  ;;   +24: lParam      (app-defined data)
  ;;   +28: pszText     (guest pointer to NUL-terminated text)

  (global $tv_next_handle (mut i32) (i32.const 0xCC000001))
  (global $tv_count (mut i32) (i32.const 0))

  ;; Find slot index for a handle, return -1 if not found
  (func $tv_find_slot (param $handle i32) (result i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
        (if (i32.eq (i32.load (i32.add (i32.const 0x9000) (i32.mul (local.get $i) (i32.const 32)))) (local.get $handle))
          (then (return (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const -1))

  ;; Find free slot, return index or -1 if full
  (func $tv_alloc_slot (result i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
        (if (i32.eqz (i32.load (i32.add (i32.const 0x9000) (i32.mul (local.get $i) (i32.const 32)))))
          (then (return (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const -1))

  ;; TVM_INSERTITEMA handler
  ;; lParam_wa = WASM address of TV_INSERTSTRUCT
  ;; TV_INSERTSTRUCT: hParent(+0), hInsertAfter(+4), TVITEMA(+8)
  ;; TVITEMA: mask(+0), hItem(+4), state(+8), stateMask(+12), pszText(+16), ..., lParam(+36)
  (func $tv_insert (param $lParam_wa i32) (result i32)
    (local $slot i32) (local $base i32) (local $handle i32)
    (local $hParent i32) (local $state i32) (local $mask i32)
    (local $parent_slot i32) (local $sib i32)
    ;; Allocate slot
    (local.set $slot (call $tv_alloc_slot))
    (if (i32.eq (local.get $slot) (i32.const -1))
      (then (return (i32.const 0))))
    ;; Generate handle
    (local.set $handle (global.get $tv_next_handle))
    (global.set $tv_next_handle (i32.add (global.get $tv_next_handle) (i32.const 1)))
    (global.set $tv_count (i32.add (global.get $tv_count) (i32.const 1)))
    ;; Slot base address
    (local.set $base (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32))))
    ;; Store handle
    (i32.store (local.get $base) (local.get $handle))
    ;; Read parent from TV_INSERTSTRUCT
    (local.set $hParent (i32.load (local.get $lParam_wa)))
    (i32.store offset=4 (local.get $base) (local.get $hParent))
    ;; Init child/sibling pointers
    (i32.store offset=8 (local.get $base) (i32.const 0))   ;; firstChild
    (i32.store offset=12 (local.get $base) (i32.const 0))  ;; nextSib
    (i32.store offset=16 (local.get $base) (i32.const 0))  ;; prevSib
    ;; Read TVITEMA fields (at offset +8 in TV_INSERTSTRUCT)
    (local.set $mask (i32.load (i32.add (local.get $lParam_wa) (i32.const 8))))
    ;; State: if mask includes TVIF_STATE (0x8), use provided state; else default checked
    (if (i32.and (local.get $mask) (i32.const 0x8))
      (then
        (local.set $state (i32.load (i32.add (local.get $lParam_wa) (i32.const 16)))))
      (else
        (local.set $state (i32.const 0x2000))))  ;; default: checked
    (i32.store offset=20 (local.get $base) (local.get $state))
    ;; lParam: if mask includes TVIF_PARAM (0x4), read it
    (if (i32.and (local.get $mask) (i32.const 0x4))
      (then
        (i32.store offset=24 (local.get $base)
          (i32.load (i32.add (local.get $lParam_wa) (i32.const 44))))))  ;; TVITEMA.lParam at +36 from TVITEMA = +44 from struct start
    ;; pszText: if mask includes TVIF_TEXT (0x1), store guest pointer at +28
    (if (i32.and (local.get $mask) (i32.const 0x1))
      (then
        (i32.store offset=28 (local.get $base)
          (i32.load (i32.add (local.get $lParam_wa) (i32.const 24))))))
    ;; Link into parent's child list
    (if (local.get $hParent)
      (then
        (local.set $parent_slot (call $tv_find_slot (local.get $hParent)))
        (if (i32.ne (local.get $parent_slot) (i32.const -1))
          (then
            (local.set $sib (i32.load offset=8
              (i32.add (i32.const 0x9000) (i32.mul (local.get $parent_slot) (i32.const 32)))))
            (if (i32.eqz (local.get $sib))
              (then
                ;; First child
                (i32.store offset=8
                  (i32.add (i32.const 0x9000) (i32.mul (local.get $parent_slot) (i32.const 32)))
                  (local.get $handle)))
              (else
                ;; Find last sibling, append
                (block $end
                  (loop $find
                    (local.set $slot (call $tv_find_slot (local.get $sib)))
                    (br_if $end (i32.eq (local.get $slot) (i32.const -1)))
                    (if (i32.eqz (i32.load offset=12
                          (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32)))))
                      (then
                        ;; This is the last sibling — link new item
                        (i32.store offset=12
                          (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32)))
                          (local.get $handle))
                        (i32.store offset=16 (local.get $base) (local.get $sib))
                        (br $end)))
                    (local.set $sib (i32.load offset=12
                      (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32)))))
                    (br $find)))))))))
    (local.get $handle))

  ;; TVM_GETITEMA handler — read TVITEM, fill requested fields
  (func $tv_get_item (param $tvitem_wa i32) (result i32)
    (local $mask i32) (local $hItem i32) (local $slot i32) (local $base i32)
    (local.set $mask (i32.load (local.get $tvitem_wa)))
    (local.set $hItem (i32.load offset=4 (local.get $tvitem_wa)))
    (local.set $slot (call $tv_find_slot (local.get $hItem)))
    (if (i32.eq (local.get $slot) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $base (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32))))
    ;; TVIF_STATE (0x8) — write state at TVITEM+8
    (if (i32.and (local.get $mask) (i32.const 0x8))
      (then
        (i32.store offset=8 (local.get $tvitem_wa)
          (i32.and (i32.load offset=20 (local.get $base))
                   (i32.load offset=12 (local.get $tvitem_wa))))))  ;; mask with stateMask
    ;; TVIF_PARAM (0x4) — write lParam at TVITEM+36
    (if (i32.and (local.get $mask) (i32.const 0x4))
      (then
        (i32.store (i32.add (local.get $tvitem_wa) (i32.const 36))
          (i32.load offset=24 (local.get $base)))))
    (i32.const 1))

  ;; TVM_SETITEMA handler
  (func $tv_set_item (param $tvitem_wa i32) (result i32)
    (local $mask i32) (local $hItem i32) (local $slot i32) (local $base i32)
    (local.set $mask (i32.load (local.get $tvitem_wa)))
    (local.set $hItem (i32.load offset=4 (local.get $tvitem_wa)))
    (local.set $slot (call $tv_find_slot (local.get $hItem)))
    (if (i32.eq (local.get $slot) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $base (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32))))
    ;; TVIF_STATE (0x8)
    (if (i32.and (local.get $mask) (i32.const 0x8))
      (then
        (i32.store offset=20 (local.get $base)
          (i32.or
            (i32.and (i32.load offset=20 (local.get $base))
                     (i32.xor (i32.load offset=12 (local.get $tvitem_wa)) (i32.const -1)))
            (i32.and (i32.load offset=8 (local.get $tvitem_wa))
                     (i32.load offset=12 (local.get $tvitem_wa)))))))
    ;; TVIF_PARAM (0x4)
    (if (i32.and (local.get $mask) (i32.const 0x4))
      (then
        (i32.store offset=24 (local.get $base)
          (i32.load (i32.add (local.get $tvitem_wa) (i32.const 36))))))
    (i32.const 1))

  ;; TVM_GETNEXTITEM handler
  (func $tv_get_next (param $flag i32) (param $hItem i32) (result i32)
    (local $slot i32) (local $base i32) (local $i i32)
    ;; TVGN_ROOT (0) — find first root item
    (if (i32.eqz (local.get $flag))
      (then
        (local.set $i (i32.const 0))
        (block $done
          (loop $loop
            (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
            (local.set $base (i32.add (i32.const 0x9000) (i32.mul (local.get $i) (i32.const 32))))
            (if (i32.and (i32.ne (i32.load (local.get $base)) (i32.const 0))  ;; handle != 0
                         (i32.eqz (i32.load offset=4 (local.get $base))))  ;; parent == 0
              (then (return (i32.load (local.get $base)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $loop)))
        (return (i32.const 0))))
    ;; Need to find the item
    (local.set $slot (call $tv_find_slot (local.get $hItem)))
    (if (i32.eq (local.get $slot) (i32.const -1))
      (then (return (i32.const 0))))
    (local.set $base (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32))))
    ;; TVGN_NEXT (1) — next sibling
    (if (i32.eq (local.get $flag) (i32.const 1))
      (then (return (i32.load offset=12 (local.get $base)))))
    ;; TVGN_PREVIOUS (2) — prev sibling
    (if (i32.eq (local.get $flag) (i32.const 2))
      (then (return (i32.load offset=16 (local.get $base)))))
    ;; TVGN_PARENT (3)
    (if (i32.eq (local.get $flag) (i32.const 3))
      (then (return (i32.load offset=4 (local.get $base)))))
    ;; TVGN_CHILD (4) — first child
    (if (i32.eq (local.get $flag) (i32.const 4))
      (then (return (i32.load offset=8 (local.get $base)))))
    ;; TVGN_CARET (9) — selected item, just return the requested item
    (if (i32.eq (local.get $flag) (i32.const 9))
      (then (return (local.get $hItem))))
    (i32.const 0))

  ;; Main TreeView message dispatcher
  (func $treeview_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    ;; TVM_INSERTITEMA (0x1100)
    (if (i32.eq (local.get $msg) (i32.const 0x1100))
      (then (return (call $tv_insert (call $g2w (local.get $lParam))))))
    ;; TVM_DELETEITEM (0x1101) — simplified: just clear the slot
    (if (i32.eq (local.get $msg) (i32.const 0x1101))
      (then
        (if (i32.ne (call $tv_find_slot (local.get $lParam)) (i32.const -1))
          (then
            (i32.store (i32.add (i32.const 0x9000)
              (i32.mul (call $tv_find_slot (local.get $lParam)) (i32.const 32))) (i32.const 0))
            (global.set $tv_count (i32.sub (global.get $tv_count) (i32.const 1)))))
        (return (i32.const 1))))
    ;; TVM_GETCOUNT (0x1105)
    (if (i32.eq (local.get $msg) (i32.const 0x1105))
      (then (return (global.get $tv_count))))
    ;; TVM_SETIMAGELIST (0x1109) — no-op
    (if (i32.eq (local.get $msg) (i32.const 0x1109))
      (then (return (i32.const 0))))
    ;; TVM_GETNEXTITEM (0x110a)
    (if (i32.eq (local.get $msg) (i32.const 0x110a))
      (then (return (call $tv_get_next (local.get $wParam) (local.get $lParam)))))
    ;; TVM_SELECTITEM (0x110b) — no-op
    (if (i32.eq (local.get $msg) (i32.const 0x110b))
      (then (return (i32.const 1))))
    ;; TVM_GETITEMA (0x110c)
    (if (i32.eq (local.get $msg) (i32.const 0x110c))
      (then (return (call $tv_get_item (call $g2w (local.get $lParam))))))
    ;; TVM_SETITEMA (0x110d)
    (if (i32.eq (local.get $msg) (i32.const 0x110d))
      (then (return (call $tv_set_item (call $g2w (local.get $lParam))))))
    ;; Default
    (i32.const 0))

  (func $tv_item_depth (param $base i32) (result i32)
    (local $parent i32) (local $slot i32) (local $depth i32)
    (local.set $parent (i32.load offset=4 (local.get $base)))
    (block $done (loop $walk
      (br_if $done (i32.eqz (local.get $parent)))
      (br_if $done (i32.ge_u (local.get $depth) (i32.const 8)))
      (local.set $slot (call $tv_find_slot (local.get $parent)))
      (br_if $done (i32.eq (local.get $slot) (i32.const -1)))
      (local.set $depth (i32.add (local.get $depth) (i32.const 1)))
      (local.set $parent (i32.load offset=4
        (i32.add (i32.const 0x9000) (i32.mul (local.get $slot) (i32.const 32)))))
      (br $walk)))
    (local.get $depth))

  (func $treeview_paint_wat (param $hwnd i32)
    (local $hdc i32) (local $sz i32) (local $w i32) (local $h i32)
    (local $i i32) (local $base i32) (local $row i32) (local $y i32)
    (local $depth i32) (local $x i32) (local $state i32) (local $check i32)
    (local $text_g i32) (local $text_w i32) (local $text_len i32)
    (local.set $hdc (i32.add (local.get $hwnd) (i32.const 0x40000)))
    (local.set $sz (call $ctrl_get_wh_packed (local.get $hwnd)))
    (local.set $w (i32.and (local.get $sz) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (local.get $sz) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $w)) (i32.eqz (local.get $h)))
      (then (return)))

    (drop (call $host_gdi_select_object (local.get $hdc) (i32.const 0x30021)))
    (drop (call $host_gdi_set_bk_mode (local.get $hdc) (i32.const 1)))
    (drop (call $host_gdi_set_text_color (local.get $hdc) (i32.const 0x00000000)))
    (drop (call $host_gdi_fill_rect (local.get $hdc)
      (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
      (i32.const 0x30010)))
    (drop (call $host_gdi_draw_edge (local.get $hdc)
      (i32.const 0) (i32.const 0) (local.get $w) (local.get $h)
      (i32.const 0x0A) (i32.const 0x0F)))

    (local.set $i (i32.const 0))
    (local.set $row (i32.const 0))
    (block $done (loop $items
      (br_if $done (i32.ge_u (local.get $i) (i32.const 32)))
      (local.set $base (i32.add (i32.const 0x9000) (i32.mul (local.get $i) (i32.const 32))))
      (if (i32.load (local.get $base))
        (then
          (local.set $y (i32.add (i32.const 3) (i32.mul (local.get $row) (i32.const 16))))
          (if (i32.lt_u (local.get $y) (i32.sub (local.get $h) (i32.const 4)))
            (then
              (local.set $depth (call $tv_item_depth (local.get $base)))
              (local.set $x (i32.add (i32.const 4) (i32.mul (local.get $depth) (i32.const 16))))

              (if (i32.load offset=8 (local.get $base))
                (then
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $x) (i32.add (local.get $y) (i32.const 3))
                    (i32.add (local.get $x) (i32.const 9)) (i32.add (local.get $y) (i32.const 12))
                    (i32.const 0x30010)))
                  (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (local.get $x) (i32.add (local.get $y) (i32.const 3))
                    (i32.add (local.get $x) (i32.const 9)) (i32.add (local.get $y) (i32.const 12))
                    (i32.const 0x0A) (i32.const 0x0F)))
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $x) (i32.const 2)) (i32.add (local.get $y) (i32.const 7))
                    (i32.add (local.get $x) (i32.const 7)) (i32.add (local.get $y) (i32.const 8))
                    (i32.const 0x30014)))
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (i32.add (local.get $x) (i32.const 4)) (i32.add (local.get $y) (i32.const 5))
                    (i32.add (local.get $x) (i32.const 5)) (i32.add (local.get $y) (i32.const 10))
                    (i32.const 0x30014)))
                  (local.set $x (i32.add (local.get $x) (i32.const 12))))))

              (local.set $state (i32.load offset=20 (local.get $base)))
              (local.set $check (i32.and (i32.shr_u (local.get $state) (i32.const 12)) (i32.const 0xF)))
              (if (local.get $check)
                (then
                  (drop (call $host_gdi_fill_rect (local.get $hdc)
                    (local.get $x) (i32.add (local.get $y) (i32.const 1))
                    (i32.add (local.get $x) (i32.const 12)) (i32.add (local.get $y) (i32.const 13))
                    (i32.const 0x30010)))
                  (drop (call $host_gdi_draw_edge (local.get $hdc)
                    (local.get $x) (i32.add (local.get $y) (i32.const 1))
                    (i32.add (local.get $x) (i32.const 12)) (i32.add (local.get $y) (i32.const 13))
                    (i32.const 0x0A) (i32.const 0x0F)))
                  (if (i32.ge_u (local.get $check) (i32.const 2))
                    (then
                      (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.add (local.get $x) (i32.const 3)) (i32.add (local.get $y) (i32.const 7))
                        (i32.add (local.get $x) (i32.const 5)) (i32.add (local.get $y) (i32.const 9))
                        (i32.const 0x30014)))
                      (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.add (local.get $x) (i32.const 5)) (i32.add (local.get $y) (i32.const 9))
                        (i32.add (local.get $x) (i32.const 7)) (i32.add (local.get $y) (i32.const 11))
                        (i32.const 0x30014)))
                      (drop (call $host_gdi_fill_rect (local.get $hdc)
                        (i32.add (local.get $x) (i32.const 7)) (i32.add (local.get $y) (i32.const 5))
                        (i32.add (local.get $x) (i32.const 10)) (i32.add (local.get $y) (i32.const 7))
                        (i32.const 0x30014)))))
                  (local.set $x (i32.add (local.get $x) (i32.const 16))))))

              (local.set $text_g (i32.load offset=28 (local.get $base)))
              (if (local.get $text_g)
                (then
                  (local.set $text_w (call $g2w (local.get $text_g)))
                  (local.set $text_len (call $strlen (local.get $text_w)))
                  (if (local.get $text_len)
                    (then
                      (drop (call $host_gdi_text_out (local.get $hdc)
                        (local.get $x) (i32.add (local.get $y) (i32.const 1))
                        (local.get $text_w) (local.get $text_len) (i32.const 0))))))))
              (local.set $row (i32.add (local.get $row) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $items))))

  ;; TreeView control wndproc — handles WM_PAINT and TreeView messages
  (func $treeview_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    ;; WM_PAINT (0x000F) — draw the tree into the parent's back canvas
    (if (i32.eq (local.get $msg) (i32.const 0x000F))
      (then
        (call $treeview_paint_wat (local.get $hwnd))
        (return (i32.const 0))))
    ;; WM_ERASEBKGND (0x0014)
    (if (i32.eq (local.get $msg) (i32.const 0x0014))
      (then (return (i32.const 1))))
    ;; TreeView messages (0x1100-0x1150)
    (if (i32.and (i32.ge_u (local.get $msg) (i32.const 0x1100))
                 (i32.le_u (local.get $msg) (i32.const 0x1150)))
      (then (return (call $treeview_dispatch
        (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    (i32.const 0))
