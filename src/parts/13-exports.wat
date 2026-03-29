  ;; ============================================================
  ;; MAIN RUN LOOP
  ;; ============================================================
  (func $run (export "run") (param $max_blocks i32)
    (local $thread i32) (local $blocks i32)
    (local.set $blocks (local.get $max_blocks))
    (block $halt (loop $main
      (br_if $halt (i32.le_s (local.get $blocks) (i32.const 0)))
      (br_if $halt (i32.eqz (global.get $eip)))
      (local.set $blocks (i32.sub (local.get $blocks) (i32.const 1)))
      ;; Reset thread buffer if approaching cache region (leave 4KB margin)
      (if (i32.ge_u (global.get $thread_alloc) (i32.sub (global.get $CACHE_INDEX) (i32.const 4096)))
        (then
          (global.set $thread_alloc (global.get $THREAD_BASE))
          (call $clear_cache)))
      ;; Watchpoint: break when watched dword changes
      (if (global.get $watch_addr)
        (then
          (if (i32.ne (call $gl32 (global.get $watch_addr)) (global.get $watch_val))
            (then
              (global.set $watch_val (call $gl32 (global.get $watch_addr)))
              (br $halt)))))
      ;; EIP breakpoint
      (if (i32.eq (global.get $eip) (global.get $bp_addr))
        (then (br $halt)))
      (local.set $thread (call $cache_lookup (global.get $eip)))
      (if (i32.eqz (local.get $thread))
        (then (local.set $thread (call $decode_block (global.get $eip)))))
      (global.set $ip (local.get $thread))
      ;; Set steps high enough to always complete a block
      (global.set $steps (i32.const 1000))
      (call $next)
      (br $main))))

  ;; ============================================================
  ;; DEBUG EXPORTS
  ;; ============================================================
  (func (export "get_eip") (result i32) (global.get $eip))
  (func (export "get_esp") (result i32) (global.get $esp))
  (func (export "get_eax") (result i32) (global.get $eax))
  (func (export "get_ecx") (result i32) (global.get $ecx))
  (func (export "get_edx") (result i32) (global.get $edx))
  (func (export "get_ebx") (result i32) (global.get $ebx))
  (func (export "get_ebp") (result i32) (global.get $ebp))
  (func (export "get_esi") (result i32) (global.get $esi))
  (func (export "get_edi") (result i32) (global.get $edi))
  (func (export "get_staging") (result i32) (global.get $PE_STAGING))
  (func (export "get_fs_base") (result i32) (global.get $fs_base))
  (func (export "get_image_base") (result i32) (global.get $image_base))
  (func (export "get_thread_alloc") (result i32) (global.get $thread_alloc))
  (func (export "get_wndproc") (result i32) (global.get $wndproc_addr))
  (func (export "get_thunk_base") (result i32) (global.get $thunk_guest_base))
  (func (export "get_thunk_end") (result i32) (global.get $thunk_guest_end))
  (func (export "get_num_thunks") (result i32) (global.get $num_thunks))

  ;; Flag debugging exports
  (func (export "get_flag_res") (result i32) (global.get $flag_res))
  (func (export "get_flag_op") (result i32) (global.get $flag_op))
  (func (export "get_flag_a") (result i32) (global.get $flag_a))
  (func (export "get_flag_b") (result i32) (global.get $flag_b))
  (func (export "get_flag_sign_shift") (result i32) (global.get $flag_sign_shift))

  (func (export "get_heap_ptr") (result i32) (global.get $heap_ptr))
  (func (export "get_main_win_cx") (result i32) (global.get $main_win_cx))
  (func (export "get_main_win_cy") (result i32) (global.get $main_win_cy))

  ;; Register setters for test harness
  (func (export "set_eip") (param i32) (global.set $eip (local.get 0)))
  (func (export "set_esp") (param i32) (global.set $esp (local.get 0)))
  (func (export "set_ebp") (param i32) (global.set $ebp (local.get 0)))
  (func (export "set_eax") (param i32) (global.set $eax (local.get 0)))
  (func (export "set_ecx") (param i32) (global.set $ecx (local.get 0)))
  (func (export "set_edx") (param i32) (global.set $edx (local.get 0)))
  (func (export "set_ebx") (param i32) (global.set $ebx (local.get 0)))
  (func (export "set_esi") (param i32) (global.set $esi (local.get 0)))
  (func (export "set_edi") (param i32) (global.set $edi (local.get 0)))

  ;; Watchpoint exports
  (func (export "set_bp") (param $addr i32) (global.set $bp_addr (local.get $addr)))
  (func (export "clear_bp") (global.set $bp_addr (i32.const 0)))
  (func (export "set_watchpoint") (param $addr i32)
    (global.set $watch_addr (local.get $addr))
    (if (local.get $addr)
      (then (global.set $watch_val (call $gl32 (local.get $addr))))
      (else (global.set $watch_val (i32.const 0)))))
  (func (export "get_watch_val") (result i32) (global.get $watch_val))
  (func (export "get_watch_addr") (result i32) (global.get $watch_addr))

  ;; call_func(addr, arg0, arg1, arg2, arg3): push args right-to-left + halt
  ;; return addr, set EIP, then caller uses run() to execute. Result in EAX.
  (func (export "call_func") (param $addr i32) (param $a0 i32) (param $a1 i32) (param $a2 i32) (param $a3 i32)
    ;; Push args right-to-left (stdcall/cdecl convention)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a3))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a2))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a1))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $a0))
    ;; Push return address = 0 (will halt when RET tries to jump to 0)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))
    ;; Set EIP to function address
    (global.set $eip (local.get $addr))
  )

  ;; Write guest memory (guest addr)
  (func (export "guest_write32") (param $ga i32) (param $val i32)
    (call $gs32 (local.get $ga) (local.get $val)))
  (func (export "guest_read32") (param $ga i32) (result i32)
    (call $gl32 (local.get $ga)))

  ;; Allocate guest heap memory (returns guest address)
  (func (export "guest_alloc") (param $size i32) (result i32)
    (call $heap_alloc (local.get $size)))

  ;; Write 16-bit value to guest memory
  (func (export "guest_write16") (param $ga i32) (param $val i32)
    (call $gs16 (local.get $ga) (local.get $val)))

  ;; Get GUEST_BASE for direct WASM memory access
  (func (export "get_guest_base") (result i32) (global.get $GUEST_BASE))
)
