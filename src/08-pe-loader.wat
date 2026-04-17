  ;; ============================================================
  ;; PE LOADER
  ;; ============================================================
  (func $load_pe (export "load_pe") (param $size i32) (result i32)
    (local $pe_off i32) (local $num_sections i32) (local $opt_hdr_size i32)
    (local $section_off i32) (local $i i32) (local $vaddr i32) (local $vsize i32)
    (local $raw_off i32) (local $raw_size i32) (local $import_rva i32)
    (local $src i32) (local $dst i32) (local $characteristics i32)

    (if (i32.ne (i32.load16_u (global.get $PE_STAGING)) (i32.const 0x5A4D)) (then (return (i32.const -1))))
    (local.set $pe_off (i32.add (global.get $PE_STAGING)
      (i32.load (i32.add (global.get $PE_STAGING) (i32.const 0x3C)))))
    (if (i32.ne (i32.load (local.get $pe_off)) (i32.const 0x00004550)) (then (return (i32.const -2))))

    (local.set $num_sections (i32.load16_u (i32.add (local.get $pe_off) (i32.const 6))))
    (local.set $opt_hdr_size (i32.load16_u (i32.add (local.get $pe_off) (i32.const 20))))
    (global.set $image_base (i32.load (i32.add (local.get $pe_off) (i32.const 52))))
    (global.set $entry_point (i32.add (global.get $image_base) (i32.load (i32.add (local.get $pe_off) (i32.const 40)))))
    ;; Compute guest-space thunk zone bounds
    (global.set $thunk_guest_base (i32.add (i32.sub (global.get $THUNK_BASE) (global.get $GUEST_BASE)) (global.get $image_base)))
    (global.set $thunk_guest_end  (i32.add (i32.sub (global.get $THUNK_END)  (global.get $GUEST_BASE)) (global.get $image_base)))
    (local.set $import_rva (i32.load (i32.add (local.get $pe_off) (i32.const 128))))
    ;; Resource directory RVA = data directory entry 2 (offset 136 in optional header)
    (global.set $rsrc_rva (i32.load (i32.add (local.get $pe_off) (i32.const 136))))

    ;; Store SizeOfImage for DLL loader
    (global.set $exe_size_of_image (i32.load (i32.add (local.get $pe_off) (i32.const 80))))
    ;; Set heap to be above the image
    (global.set $heap_base (i32.add (global.get $image_base) (global.get $exe_size_of_image)))
    (global.set $heap_ptr (global.get $heap_base))

    ;; Copy DOS+PE headers into guest memory (CRT startup reads MZ signature from image base)
    (call $memcpy (global.get $GUEST_BASE) (global.get $PE_STAGING)
      (i32.load (i32.add (local.get $pe_off) (i32.const 84))))  ;; SizeOfHeaders

    (local.set $section_off (i32.add (local.get $pe_off) (i32.add (i32.const 24) (local.get $opt_hdr_size))))
    (local.set $i (i32.const 0))
    (block $sd (loop $sl
      (br_if $sd (i32.ge_u (local.get $i) (local.get $num_sections)))
      (local.set $vsize (i32.load (i32.add (local.get $section_off) (i32.const 8))))
      (local.set $vaddr (i32.load (i32.add (local.get $section_off) (i32.const 12))))
      (local.set $raw_size (i32.load (i32.add (local.get $section_off) (i32.const 16))))
      (local.set $raw_off (i32.load (i32.add (local.get $section_off) (i32.const 20))))
      (local.set $characteristics (i32.load (i32.add (local.get $section_off) (i32.const 36))))
      (local.set $dst (i32.add (global.get $GUEST_BASE) (local.get $vaddr)))
      (local.set $src (i32.add (global.get $PE_STAGING) (local.get $raw_off)))
      (call $memcpy (local.get $dst) (local.get $src) (local.get $raw_size))
      ;; Zero BSS portion: if VirtualSize > RawSize, zero the remainder
      (if (i32.gt_u (local.get $vsize) (local.get $raw_size))
        (then (call $zero_memory
          (i32.add (local.get $dst) (local.get $raw_size))
          (i32.sub (local.get $vsize) (local.get $raw_size)))))
      (if (i32.and (local.get $characteristics) (i32.const 0x20))
        (then
          (global.set $code_start (i32.add (global.get $image_base) (local.get $vaddr)))
          (global.set $code_end (i32.add (global.get $code_start) (local.get $vsize)))))
      (local.set $section_off (i32.add (local.get $section_off) (i32.const 40)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sl)))

    (if (i32.ne (local.get $import_rva) (i32.const 0))
      (then (call $process_imports (local.get $import_rva))))

    (global.set $eip (global.get $entry_point))
    ;; ESP must be a guest address: GUEST_STACK(WASM) → guest = WASM - GUEST_BASE + image_base
    (global.set $esp (i32.add (i32.sub (global.get $GUEST_STACK) (global.get $GUEST_BASE)) (global.get $image_base)))
    (global.set $eax (i32.const 0)) (global.set $ecx (i32.const 0))
    (global.set $edx (i32.const 0)) (global.set $ebx (i32.const 0))
    (global.set $ebp (i32.const 0)) (global.set $esi (i32.const 0))
    (global.set $edi (i32.const 0)) (global.set $df (i32.const 0))
    ;; Allocate fake TIB (Thread Information Block) for FS segment
    (global.set $fs_base (call $heap_alloc (i32.const 256)))
    (call $zero_memory (call $g2w (global.get $fs_base)) (i32.const 256))
    ;; TIB+0: SEH chain head (set to -1 = end of chain)
    (call $gs32 (global.get $fs_base) (i32.const 0xFFFFFFFF))
    ;; TIB+0x18: Self-pointer (linear address of TIB)
    (call $gs32 (i32.add (global.get $fs_base) (i32.const 0x18)) (global.get $fs_base))
    ;; TIB+0x04: Stack top
    (call $gs32 (i32.add (global.get $fs_base) (i32.const 0x04)) (global.get $esp))
    ;; TIB+0x08: Stack bottom (1MB below top)
    (call $gs32 (i32.add (global.get $fs_base) (i32.const 0x08)) (i32.sub (global.get $esp) (i32.const 0x100000)))
    (global.get $entry_point))

  ;; ============================================================
  ;; IMPORT TABLE
  ;; ============================================================
  (func $process_imports (param $import_rva i32)
    (local $desc_ptr i32) (local $ilt_rva i32) (local $iat_rva i32)
    (local $ilt_ptr i32) (local $iat_ptr i32) (local $entry i32) (local $thunk_addr i32)
    (local.set $desc_ptr (i32.add (global.get $GUEST_BASE) (local.get $import_rva)))
    (block $id (loop $dl
      (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
      (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))
      (br_if $id (i32.eqz (local.get $ilt_rva)))
      (local.set $ilt_ptr (i32.add (global.get $GUEST_BASE) (local.get $ilt_rva)))
      (local.set $iat_ptr (i32.add (global.get $GUEST_BASE) (local.get $iat_rva)))
      (block $fd (loop $fl
        (local.set $entry (i32.load (local.get $ilt_ptr)))
        (br_if $fd (i32.eqz (local.get $entry)))
        ;; WASM addr of thunk data = THUNK_BASE + idx*8
        ;; Guest addr = WASM_addr - GUEST_BASE + image_base
        (local.set $thunk_addr (i32.add
          (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                   (global.get $GUEST_BASE))
          (global.get $image_base)))
        (i32.store (local.get $iat_ptr) (local.get $thunk_addr))
        (if (i32.eqz (i32.and (local.get $entry) (i32.const 0x80000000)))
          (then
            (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (local.get $entry))
            ;; Lookup and store API ID in thunk+4
            (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
              (call $lookup_api_id (i32.add (global.get $GUEST_BASE) (i32.add (local.get $entry) (i32.const 2))))))
          (else
            ;; Ordinal import: bit 31 set, low 16 bits = ordinal number
            ;; Store ordinal as name RVA marker, resolve API ID via host
            (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (local.get $entry))
            (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
              (call $host_resolve_ordinal
                ;; DLL name ptr: desc+12 = name RVA
                (i32.add (global.get $GUEST_BASE) (i32.load (i32.add (local.get $desc_ptr) (i32.const 12))))
                ;; ordinal = entry & 0xFFFF
                (i32.and (local.get $entry) (i32.const 0xFFFF))))))
        (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
        (call $update_thunk_end)
        (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
        (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
        (br $fl)))
      (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
      (br $dl)))

    ;; Allocate catch-return thunk: guest addr for catch funclet return
    ;; Write a special marker (0xCACA0000) as the name RVA so win32_dispatch can identify it
    (global.set $catch_ret_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0000))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate CreateWindowEx continuation thunk (marker 0xCACA0001)
    (global.set $createwnd_ret_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0001))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate Synchronous SendMessage continuation thunk (marker 0xCACA0005)
    (global.set $sync_msg_ret_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0005))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
    ;; Allocate DialogBoxParamA message loop thunk (marker 0xCACA0004)
    (global.set $dlg_loop_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0004))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate _initterm continuation thunk (marker 0xCACA0003)
    (global.set $initterm_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0003))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate CBT hook continuation thunk (marker 0xCACA0002)
    (global.set $cbt_hook_ret_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0002))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate first-ShowWindow activation chain thunks (0xCACA0022..0xCACA0023)
    ;; Chain: ShowWindow → CACA0022 (WM_ACTIVATE) → CACA0023 (WM_SETFOCUS) → CACA0001 (done)
    (global.set $createwnd_activate_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0022))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    (global.set $createwnd_setfocus_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0023))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate modal dialog pump thunk (marker 0xCACA0006). Used by
    ;; $modal_begin to park EIP while a WAT-driven modal common dialog
    ;; (Open/Save/Color/Font/...) is being interacted with.
    (global.set $modal_loop_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0006))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate DirectDrawEnumerateA callback return thunk (marker 0xCACA0007)
    (global.set $ddenum_ret_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0007))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate EnumDisplayModes continuation thunk (marker 0xCACA0008)
    (global.set $enum_modes_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA0008))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

    ;; Allocate mm_timer callback return thunk (marker 0xCACA000A)
    (global.set $mm_timer_ret_thunk (i32.add
      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
      (i32.const 0xCACA000A))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))

        (call $update_thunk_end)
  )

