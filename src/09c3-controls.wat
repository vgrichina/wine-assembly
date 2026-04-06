  ;; ============================================================
  ;; CONTROL TABLE + BUILT-IN CONTROL WNDPROCS
  ;; ============================================================
  ;; Control table at WASM 0x2980: maps window slot → control metadata (max 64 entries)
  ;; Each entry: [ctrl_class:i32, ctrl_id:i32, check_state:i32, reserved:i32] = 16 bytes
  ;; Indexed by slot from $wnd_table_find(hwnd)
  ;;
  ;; ctrl_class: 0=not a control, 1=Button, 2=Edit, 3=Static, 4=ListBox, 5=ComboBox
  ;; ctrl_id: dialog control ID
  ;; check_state: BST_UNCHECKED(0) / BST_CHECKED(1) / BST_INDETERMINATE(2)

  ;; ---- Control table helpers ----

  ;; Set control class and ID for a window table slot
  (func $ctrl_table_set (param $slot i32) (param $class i32) (param $ctrl_id i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $slot) (i32.const 16))))
    (i32.store (local.get $addr) (local.get $class))
    (i32.store (i32.add (local.get $addr) (i32.const 4)) (local.get $ctrl_id))
    (i32.store (i32.add (local.get $addr) (i32.const 8)) (i32.const 0))  ;; check_state = 0
    (i32.store (i32.add (local.get $addr) (i32.const 12)) (i32.const 0)) ;; reserved
  )

  ;; Get control class for a hwnd (returns 0 if not a control)
  (func $ctrl_table_get_class (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16))))
  )

  ;; Get check state for a control hwnd
  (func $ctrl_get_check_state (param $hwnd i32) (result i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.eq (local.get $idx) (i32.const -1))
      (then (return (i32.const 0))))
    (i32.load (i32.add (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 8)))
  )

  ;; Set check state for a control hwnd
  (func $ctrl_set_check_state (param $hwnd i32) (param $state i32)
    (local $idx i32)
    (local.set $idx (call $wnd_table_find (local.get $hwnd)))
    (if (i32.ne (local.get $idx) (i32.const -1))
      (then
        (i32.store (i32.add (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $idx) (i32.const 16))) (i32.const 8))
          (local.get $state))))
  )

  ;; Find child control hwnd by parent and control ID
  ;; Scans all window table slots for a control with matching parent and ctrl_id
  (func $ctrl_find_by_id (param $parent_hwnd i32) (param $ctrl_id i32) (result i32)
    (local $i i32)
    (local $addr i32)
    (local $hwnd i32)
    (local $ctrl_addr i32)
    (local.set $i (i32.const 0))
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (global.get $MAX_WINDOWS)))
        (local.set $addr (i32.add (global.get $WND_TABLE) (i32.mul (local.get $i) (i32.const 8))))
        (local.set $hwnd (i32.load (local.get $addr)))
        (if (i32.ne (local.get $hwnd) (i32.const 0))
          (then
            ;; Check if this slot's parent matches and ctrl_id matches
            (local.set $ctrl_addr (i32.add (global.get $CONTROL_TABLE) (i32.mul (local.get $i) (i32.const 16))))
            (if (i32.and
                  (i32.eq (call $wnd_get_parent (local.get $hwnd)) (local.get $parent_hwnd))
                  (i32.eq (i32.load (i32.add (local.get $ctrl_addr) (i32.const 4))) (local.get $ctrl_id)))
              (then (return (local.get $hwnd))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0)  ;; not found
  )

  ;; ---- Control WndProc dispatch ----

  ;; Dispatch to the correct control wndproc based on control class
  (func $control_wndproc_dispatch (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    (local $class i32)
    (local.set $class (call $ctrl_table_get_class (local.get $hwnd)))
    ;; Class 1 = Button
    (if (i32.eq (local.get $class) (i32.const 1))
      (then (return (call $button_wndproc (local.get $hwnd) (local.get $msg) (local.get $wParam) (local.get $lParam)))))
    ;; Other classes: return 0 (DefWindowProc)
    (i32.const 0)
  )

  ;; ---- Button WndProc ----

  (func $button_wndproc (param $hwnd i32) (param $msg i32) (param $wParam i32) (param $lParam i32) (result i32)
    ;; BM_GETCHECK = 0x00F0
    (if (i32.eq (local.get $msg) (i32.const 0x00F0))
      (then (return (call $ctrl_get_check_state (local.get $hwnd)))))
    ;; BM_SETCHECK = 0x00F1
    (if (i32.eq (local.get $msg) (i32.const 0x00F1))
      (then
        (call $ctrl_set_check_state (local.get $hwnd) (local.get $wParam))
        (return (i32.const 0))))
    ;; Default: return 0
    (i32.const 0)
  )
