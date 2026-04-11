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
  ;;   +28: reserved

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
