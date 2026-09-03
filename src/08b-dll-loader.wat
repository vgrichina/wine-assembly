  ;; ============================================================
  ;; DLL LOADER — Load PE DLLs into guest address space
  ;; ============================================================
  ;; DLL_TABLE layout at DLL_TABLE global: 32 bytes per DLL, max 16 DLLs = 512 bytes
  ;; +0:  load_addr (guest)
  ;; +4:  size_of_image
  ;; +8:  export_dir_rva
  ;; +12: num_functions (export)
  ;; +16: ordinal_base (export)
  ;; +20: addr_of_functions_rva (export)
  ;; +24: addr_of_names_rva (export)
  ;; +28: addr_of_name_ordinals_rva (export)

  ;; Load a DLL from PE_STAGING into guest memory at load_addr.
  ;; Returns DllMain entry point (guest addr), or 0 if none/error.
  (func $load_dll (export "load_dll") (param $size i32) (param $load_addr i32) (result i32)
    (local $pe_off i32) (local $num_sections i32) (local $opt_hdr_size i32)
    (local $section_off i32) (local $i i32) (local $vaddr i32) (local $vsize i32)
    (local $raw_off i32) (local $raw_size i32)
    (local $preferred_base i32) (local $delta i32)
    (local $import_rva i32) (local $export_rva i32) (local $export_size i32)
    (local $reloc_rva i32) (local $reloc_size i32)
    (local $entry_rva i32) (local $tls_rva i32) (local $characteristics i32)
    (local $dll_idx i32) (local $tbl_ptr i32)
    (local $src i32) (local $dst i32)
    (local $rsrc_rva_d i32) (local $rsrc_size_d i32) (local $rsrc_ptr i32)

    ;; Every DLL has entries in three fixed parallel tables. Refuse the load
    ;; before mapping a section when no row remains; the former unchecked 17th
    ;; load wrote its DLL metadata over DLL_RSRC_TABLE.
    (if (i32.ge_u (global.get $dll_count) (global.get $DLL_TABLE_CAPACITY))
      (then (return (i32.const 0))))

    ;; Validate MZ
    (if (i32.ne (i32.load16_u (global.get $PE_STAGING)) (i32.const 0x5A4D))
      (then (return (i32.const 0))))
    (local.set $pe_off (i32.add (global.get $PE_STAGING)
      (i32.load (i32.add (global.get $PE_STAGING) (i32.const 0x3C)))))
    ;; Validate PE
    (if (i32.ne (i32.load (local.get $pe_off)) (i32.const 0x00004550))
      (then (return (i32.const 0))))

    (local.set $num_sections (i32.load16_u (i32.add (local.get $pe_off) (i32.const 6))))
    (local.set $opt_hdr_size (i32.load16_u (i32.add (local.get $pe_off) (i32.const 20))))
    (local.set $preferred_base (i32.load (i32.add (local.get $pe_off) (i32.const 52))))
    (local.set $entry_rva (i32.load (i32.add (local.get $pe_off) (i32.const 40))))
    (local.set $delta (i32.sub (local.get $load_addr) (local.get $preferred_base)))

    ;; Read data directories
    (local.set $export_rva (i32.load (i32.add (local.get $pe_off) (i32.const 120))))
    (local.set $export_size (i32.load (i32.add (local.get $pe_off) (i32.const 124))))
    (local.set $import_rva (i32.load (i32.add (local.get $pe_off) (i32.const 128))))
    (local.set $reloc_rva (i32.load (i32.add (local.get $pe_off) (i32.const 160))))
    (local.set $reloc_size (i32.load (i32.add (local.get $pe_off) (i32.const 164))))
    ;; IMAGE_DIRECTORY_ENTRY_TLS (9). A DLL with static TLS cannot suppress
    ;; thread notifications because its runtime needs them to initialize each
    ;; thread's static TLS block.
    (local.set $tls_rva (i32.load (i32.add (local.get $pe_off) (i32.const 192))))
    ;; Resource data directory = entry #2 (offset 136 in optional header)
    (local.set $rsrc_rva_d  (i32.load (i32.add (local.get $pe_off) (i32.const 136))))
    (local.set $rsrc_size_d (i32.load (i32.add (local.get $pe_off) (i32.const 140))))

    ;; Map sections
    (local.set $section_off (i32.add (local.get $pe_off) (i32.add (i32.const 24) (local.get $opt_hdr_size))))
    (local.set $i (i32.const 0))
    (block $sd (loop $sl
      (br_if $sd (i32.ge_u (local.get $i) (local.get $num_sections)))
      (local.set $vaddr (i32.load (i32.add (local.get $section_off) (i32.const 12))))
      (local.set $raw_size (i32.load (i32.add (local.get $section_off) (i32.const 16))))
      (local.set $raw_off (i32.load (i32.add (local.get $section_off) (i32.const 20))))
      (local.set $characteristics (i32.load (i32.add (local.get $section_off) (i32.const 36))))
      (local.set $vsize (i32.load (i32.add (local.get $section_off) (i32.const 8))))
      (local.set $dst (call $g2w (i32.add (local.get $load_addr) (local.get $vaddr))))
      (if (i32.and (i32.gt_u (local.get $raw_size) (i32.const 0))
                   (i32.le_u (i32.add (local.get $raw_off) (local.get $raw_size)) (local.get $size)))
        (then
          (local.set $src (i32.add (global.get $PE_STAGING) (local.get $raw_off)))
          (call $memcpy (local.get $dst) (local.get $src) (local.get $raw_size))))
      ;; Zero BSS portion: if VirtualSize > RawSize, zero the remainder
      (if (i32.gt_u (local.get $vsize) (local.get $raw_size))
        (then (call $zero_memory
          (i32.add (local.get $dst) (local.get $raw_size))
          (i32.sub (local.get $vsize) (local.get $raw_size)))))
      (local.set $section_off (i32.add (local.get $section_off) (i32.const 40)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $sl)))

    ;; Process base relocations
    (if (i32.and (i32.ne (local.get $reloc_rva) (i32.const 0))
                 (i32.ne (local.get $delta) (i32.const 0)))
      (then (call $process_relocations (local.get $load_addr) (local.get $reloc_rva) (local.get $reloc_size) (local.get $delta))))

    ;; Store DLL metadata in DLL_TABLE
    (local.set $dll_idx (global.get $dll_count))
    (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $dll_idx) (i32.const 32))))
    (i32.store (local.get $tbl_ptr) (local.get $load_addr))
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 4))
      (i32.load (i32.add (local.get $pe_off) (i32.const 80)))) ;; SizeOfImage

    ;; Store resource directory info in DLL_RSRC_TABLE (parallel to DLL_TABLE).
    (local.set $rsrc_ptr (i32.add (global.get $DLL_RSRC_TABLE) (i32.mul (local.get $dll_idx) (i32.const 8))))
    (i32.store (local.get $rsrc_ptr)                         (local.get $rsrc_rva_d))
    (i32.store (i32.add (local.get $rsrc_ptr) (i32.const 4)) (local.get $rsrc_size_d))
    (i32.store
      (i32.add (global.get $DLL_FLAGS_TABLE) (i32.shl (local.get $dll_idx) (i32.const 2)))
      (i32.ne (local.get $tls_rva) (i32.const 0)))

    ;; Parse export directory
    (if (i32.ne (local.get $export_rva) (i32.const 0))
      (then (call $parse_exports (local.get $tbl_ptr) (local.get $load_addr) (local.get $export_rva))))

    ;; Process DLL's own imports (resolve to our thunks)
    (if (i32.ne (local.get $import_rva) (i32.const 0))
      (then (call $process_dll_imports (local.get $load_addr) (local.get $import_rva))))

    (global.set $dll_count (i32.add (global.get $dll_count) (i32.const 1)))

    ;; Push the low heap past this DLL image so allocations don't land on its
    ;; code. This has to move the PROCESS cursor in shared memory, not $heap_ptr:
    ;; that global now bounds one instance's private arena, so raising it here
    ;; would leave every other instance still reserving over the image.
    (local.set $dst (i32.and
      (i32.add (i32.add (local.get $load_addr)
        (i32.load (i32.add (local.get $pe_off) (i32.const 80)))) ;; SizeOfImage
        (i32.const 0xFFF))
      (i32.const 0xFFFFF000)))
    (call $heap_reserve_below (local.get $dst))

    ;; Return DllMain entry point
    (if (result i32) (i32.ne (local.get $entry_rva) (i32.const 0))
      (then (i32.add (local.get $load_addr) (local.get $entry_rva)))
      (else (i32.const 0))))

  ;; Resolve a live dynamic-library module handle to its DLL_TABLE slot.
  ;; The executable image is deliberately absent: DisableThreadLibraryCalls
  ;; accepts a DLL module, not GetModuleHandle(NULL)'s executable handle.
  (func $dll_index_from_module (param $module i32) (result i32)
    (local $i i32)
    (block $missing (loop $scan
      (br_if $missing (i32.ge_u (local.get $i) (global.get $dll_count)))
      (if (i32.eq (i32.load (i32.add (global.get $DLL_TABLE)
            (i32.mul (local.get $i) (i32.const 32)))) (local.get $module))
        (then (return (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const -1))

  ;; Return 1 only when this loaded DLL still wants DLL_THREAD_ATTACH/DETACH.
  ;; Exported because both cooperative and real browser Worker creation must
  ;; consult the same process-shared loader state immediately before calling
  ;; DllMain; caching this decision in JS would race a later disable call.
  (func $dll_thread_notifications_enabled (export "dll_thread_notifications_enabled")
      (param $module i32) (result i32)
    (local $index i32)
    (local.set $index (call $dll_index_from_module (local.get $module)))
    (if (result i32) (i32.lt_s (local.get $index) (i32.const 0))
      (then (i32.const 0))
      (else (i32.eqz (i32.and
        (i32.load (i32.add (global.get $DLL_FLAGS_TABLE)
          (i32.shl (local.get $index) (i32.const 2))))
        (i32.const 2))))))

  ;; Mark a DLL as notification-free. Return 0 for an invalid module or a DLL
  ;; whose PE advertises static TLS, exactly the two documented failure classes.
  (func $dll_disable_thread_notifications (param $module i32) (result i32)
    (local $index i32) (local $flags_ptr i32) (local $flags i32)
    (local.set $index (call $dll_index_from_module (local.get $module)))
    (if (i32.lt_s (local.get $index) (i32.const 0))
      (then (return (i32.const 0))))
    (local.set $flags_ptr (i32.add (global.get $DLL_FLAGS_TABLE)
      (i32.shl (local.get $index) (i32.const 2))))
    (local.set $flags (i32.load (local.get $flags_ptr)))
    (if (i32.and (local.get $flags) (i32.const 1))
      (then (return (i32.const 0))))
    (i32.store (local.get $flags_ptr) (i32.or (local.get $flags) (i32.const 2)))
    (i32.const 1))

  ;; Process base relocations: apply delta to all HIGHLOW fixups
  (func $process_relocations (param $load_addr i32) (param $reloc_rva i32) (param $reloc_size i32) (param $delta i32)
    (local $ptr i32) (local $end i32) (local $block_va i32) (local $block_size i32)
    (local $num_entries i32) (local $j i32) (local $entry i32) (local $type i32) (local $offset i32)
    (local $fixup_wa i32) (local $old_val i32)
    (local.set $ptr (call $g2w (i32.add (local.get $load_addr) (local.get $reloc_rva))))
    (local.set $end (i32.add (local.get $ptr) (local.get $reloc_size)))
    (block $done (loop $block
      (br_if $done (i32.ge_u (local.get $ptr) (local.get $end)))
      (local.set $block_va (i32.load (local.get $ptr)))
      (local.set $block_size (i32.load (i32.add (local.get $ptr) (i32.const 4))))
      (br_if $done (i32.eqz (local.get $block_size)))
      (local.set $num_entries (i32.shr_u (i32.sub (local.get $block_size) (i32.const 8)) (i32.const 1)))
      (local.set $j (i32.const 0))
      (block $ed (loop $el
        (br_if $ed (i32.ge_u (local.get $j) (local.get $num_entries)))
        (local.set $entry (i32.load16_u (i32.add (local.get $ptr) (i32.add (i32.const 8) (i32.shl (local.get $j) (i32.const 1))))))
        (local.set $type (i32.shr_u (local.get $entry) (i32.const 12)))
        (local.set $offset (i32.and (local.get $entry) (i32.const 0xFFF)))
        ;; Type 3 = IMAGE_REL_BASED_HIGHLOW (32-bit fixup)
        (if (i32.eq (local.get $type) (i32.const 3))
          (then
            (local.set $fixup_wa (call $g2w (i32.add (local.get $load_addr) (i32.add (local.get $block_va) (local.get $offset)))))
            (local.set $old_val (i32.load (local.get $fixup_wa)))
            (i32.store (local.get $fixup_wa) (i32.add (local.get $old_val) (local.get $delta)))))
        ;; Type 0 = IMAGE_REL_BASED_ABSOLUTE (padding, skip)
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $el)))
      (local.set $ptr (i32.add (local.get $ptr) (local.get $block_size)))
      (br $block))))

  ;; Parse export directory and store metadata in DLL_TABLE entry
  (func $parse_exports (param $tbl_ptr i32) (param $load_addr i32) (param $export_rva i32)
    (local $exp_wa i32)
    (local.set $exp_wa (call $g2w (i32.add (local.get $load_addr) (local.get $export_rva))))
    ;; Store export info
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 8)) (local.get $export_rva))
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 12))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 20)))) ;; NumberOfFunctions
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 16))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 16)))) ;; OrdinalBase
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 20))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 28)))) ;; AddressOfFunctions RVA
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 24))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 32)))) ;; AddressOfNames RVA
    (i32.store (i32.add (local.get $tbl_ptr) (i32.const 28))
      (i32.load (i32.add (local.get $exp_wa) (i32.const 36))))) ;; AddressOfNameOrdinals RVA

  ;; Resolve an ordinal export from a loaded DLL. Returns guest address of function.
  (func $resolve_ordinal (param $dll_idx i32) (param $ordinal i32) (result i32)
    (local $tbl_ptr i32) (local $load_addr i32) (local $func_idx i32)
    (local $func_rva i32) (local $aof_rva i32)
    (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $dll_idx) (i32.const 32))))
    (local.set $load_addr (i32.load (local.get $tbl_ptr)))
    (local.set $func_idx (i32.sub (local.get $ordinal) (i32.load (i32.add (local.get $tbl_ptr) (i32.const 16))))) ;; ordinal - OrdinalBase
    ;; Bounds check
    (if (i32.or (i32.lt_s (local.get $func_idx) (i32.const 0))
                (i32.ge_u (local.get $func_idx) (i32.load (i32.add (local.get $tbl_ptr) (i32.const 12)))))
      (then (return (i32.const 0))))
    (local.set $aof_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 20))))
    (local.set $func_rva (i32.load (call $g2w (i32.add (local.get $load_addr)
      (i32.add (local.get $aof_rva) (i32.shl (local.get $func_idx) (i32.const 2)))))))
    (if (result i32) (i32.eqz (local.get $func_rva))
      (then (i32.const 0))
      (else (i32.add (local.get $load_addr) (local.get $func_rva)))))

  ;; Resolve a named export from a loaded DLL. Returns guest address or 0.
  (func $resolve_name_export (param $dll_idx i32) (param $name_wa i32) (result i32)
    (local $tbl_ptr i32) (local $load_addr i32)
    (local $num_names i32) (local $aon_rva i32) (local $ano_rva i32) (local $aof_rva i32)
    (local $i i32) (local $name_rva i32) (local $cmp_wa i32) (local $ordinal_idx i32)
    (local $func_rva i32)
    (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $dll_idx) (i32.const 32))))
    (local.set $load_addr (i32.load (local.get $tbl_ptr)))
    ;; Read from export directory (stored in DLL_TABLE)
    ;; NumNames is in export_dir+24, but we only stored NumFunctions. Use linear search.
    ;; Actually we need NumNames from the export dir itself.
    (local.set $aon_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 24)))) ;; AddressOfNames
    (local.set $ano_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 28)))) ;; AddressOfNameOrdinals
    (local.set $aof_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 20)))) ;; AddressOfFunctions
    ;; Get NumNames from export directory
    (local.set $num_names (i32.load (i32.add
      (call $g2w (i32.add (local.get $load_addr) (i32.load (i32.add (local.get $tbl_ptr) (i32.const 8)))))
      (i32.const 24))))
    ;; Linear search through name table
    (local.set $i (i32.const 0))
    (block $found (block $notfound (loop $search
      (br_if $notfound (i32.ge_u (local.get $i) (local.get $num_names)))
      ;; Get name RVA
      (local.set $name_rva (i32.load (call $g2w (i32.add (local.get $load_addr)
        (i32.add (local.get $aon_rva) (i32.shl (local.get $i) (i32.const 2)))))))
      (local.set $cmp_wa (call $g2w (i32.add (local.get $load_addr) (local.get $name_rva))))
      ;; Compare names (both are WASM addresses of null-terminated strings)
      (if (call $str_eq (local.get $name_wa) (local.get $cmp_wa))
        (then
          ;; Get ordinal index from AddressOfNameOrdinals
          (local.set $ordinal_idx (i32.load16_u (call $g2w (i32.add (local.get $load_addr)
            (i32.add (local.get $ano_rva) (i32.shl (local.get $i) (i32.const 1)))))))
          ;; Get function RVA
          (local.set $func_rva (i32.load (call $g2w (i32.add (local.get $load_addr)
            (i32.add (local.get $aof_rva) (i32.shl (local.get $ordinal_idx) (i32.const 2)))))))
          (br $found)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $search)))
    (return (i32.const 0))) ;; not found
    (i32.add (local.get $load_addr) (local.get $func_rva)))

  ;; Compare two null-terminated strings at WASM addresses
  (func $str_eq (param $a i32) (param $b i32) (result i32)
    (local $i i32) (local $ca i32) (local $cb i32)
    (block $no (loop $l
      (local.set $ca (i32.load8_u (i32.add (local.get $a) (local.get $i))))
      (local.set $cb (i32.load8_u (i32.add (local.get $b) (local.get $i))))
      (br_if $no (i32.ne (local.get $ca) (local.get $cb)))
      (if (i32.eqz (local.get $ca)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.const 0))

  ;; Exports that keep their native handler even when the real DLL that owns
  ;; them is loaded. The math entries route CRT float helpers to the host FPU;
  ;; the comctl32 entry papers over a genuine Win98-vs-XP version gap.
  (func $native_override_export_api_id (param $name_wa i32) (result i32)
    ;; MSVC emits _ftol at every float/double-to-integer conversion.  Running
    ;; the authentic 21-instruction MSVCRT wrapper through the threaded x86
    ;; core is especially expensive in vertex-colour loops; the native handler
    ;; implements the same x87 pop, truncation and EDX:EAX result directly.
    (if (i32.eq (call $lookup_api_id (local.get $name_wa)) (i32.const 759))
      (then (return (i32.const 759)))) ;; _ftol
    (if (call $str_eq (local.get $name_wa) "ceil")
      (then (return (call $lookup_api_id "ceil"))))
    (if (call $str_eq (local.get $name_wa) "sqrt")
      (then (return (call $lookup_api_id "sqrt"))))
    (if (call $str_eq (local.get $name_wa) "sin")
      (then (return (call $lookup_api_id "sin"))))
    (if (call $str_eq (local.get $name_wa) "pow")
      (then (return (call $lookup_api_id "pow"))))
    (if (call $str_eq (local.get $name_wa) "_CIpow")
      (then (return (call $lookup_api_id "_CIpow"))))
    ;; Win98's comctl32 rejects every ICC_* bit in 0x7fff8000, so an XP-era
    ;; caller asking for ICC_LINK_CLASS (0x8000) gets FALSE and quits. The
    ;; classes themselves are registered from the DLL's DllMain, so answering
    ;; natively costs nothing and matches how a newer comctl32 would behave.
    (if (call $str_eq (local.get $name_wa) "InitCommonControlsEx")
      (then (return (call $lookup_api_id "InitCommonControlsEx"))))
    (i32.const -1))

  ;; WinSock 1.1 commonly imports WSOCK32 by ordinal. Resolve ordinals for
  ;; APIs already handled by the normal dispatch table; leave unsupported
  ;; ordinals explicit so they still produce the diagnostic marker below.
  (func $guest_name_has_basename8_ci
        (param $name i32)
        (param $c0 i32) (param $c1 i32) (param $c2 i32) (param $c3 i32)
        (param $c4 i32) (param $c5 i32) (param $c6 i32) (param $c7 i32)
        (result i32)
    (local $start i32) (local $scan i32) (local $c i32)
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (block $base_done (loop $base
      (local.set $c (call $gl8 (i32.add (local.get $name) (local.get $scan))))
      (br_if $base_done (i32.eqz (local.get $c)))
      (if (i32.or
            (i32.or (i32.eq (local.get $c) (i32.const 92))
                    (i32.eq (local.get $c) (i32.const 47)))
            (i32.eq (local.get $c) (i32.const 58)))
        (then (local.set $start (i32.add (local.get $scan) (i32.const 1)))))
      (local.set $scan (i32.add (local.get $scan) (i32.const 1)))
      (br $base)))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (local.get $start)))) (local.get $c0)) (then (return (i32.const 0))))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 1))))) (local.get $c1)) (then (return (i32.const 0))))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 2))))) (local.get $c2)) (then (return (i32.const 0))))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 3))))) (local.get $c3)) (then (return (i32.const 0))))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 4))))) (local.get $c4)) (then (return (i32.const 0))))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 5))))) (local.get $c5)) (then (return (i32.const 0))))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 6))))) (local.get $c6)) (then (return (i32.const 0))))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 7))))) (local.get $c7)) (then (return (i32.const 0))))
    (call $guest_name_tail_is_dll
      (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 8)))))

  (func $guest_name_is_ws2_32_ci (param $name i32) (result i32)
    (local $start i32) (local $scan i32) (local $c i32)
    (if (i32.eqz (local.get $name)) (then (return (i32.const 0))))
    (block $base_done (loop $base
      (local.set $c (call $gl8 (i32.add (local.get $name) (local.get $scan))))
      (br_if $base_done (i32.eqz (local.get $c)))
      (if (i32.or
            (i32.or (i32.eq (local.get $c) (i32.const 92))
                    (i32.eq (local.get $c) (i32.const 47)))
            (i32.eq (local.get $c) (i32.const 58)))
        (then (local.set $start (i32.add (local.get $scan) (i32.const 1)))))
      (local.set $scan (i32.add (local.get $scan) (i32.const 1)))
      (br $base)))
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (local.get $start)))) (i32.const 0x77)) (then (return (i32.const 0)))) ;; w
    (if (i32.ne (call $tolower (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 1))))) (i32.const 0x73)) (then (return (i32.const 0)))) ;; s
    (if (i32.ne (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 2)))) (i32.const 0x32)) (then (return (i32.const 0)))) ;; 2
    (if (i32.ne (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 3)))) (i32.const 0x5F)) (then (return (i32.const 0)))) ;; _
    (if (i32.ne (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 4)))) (i32.const 0x33)) (then (return (i32.const 0)))) ;; 3
    (if (i32.ne (call $gl8 (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 5)))) (i32.const 0x32)) (then (return (i32.const 0)))) ;; 2
    (call $guest_name_tail_is_dll
      (i32.add (local.get $name) (i32.add (local.get $start) (i32.const 6)))))

  (func $system_ordinal_api_id (param $dll_name_ga i32) (param $ordinal i32) (result i32)
    ;; Authentic Win98 SE KERNEL32.DLL: ordinal 99 is unnamed, RVA 0x1e260.
    ;; Its native body takes one BOOL refresh flag and returns the current
    ;; TIME_ZONE_ID_* classification (0 unknown, 1 standard, 2 daylight).
    (if (call $dll_name_match (local.get $dll_name_ga) "KERNEL32.dll")
      (then
        (if (i32.eq (local.get $ordinal) (i32.const 99))
          (then (return (call $lookup_api_id "KERNEL32_Ordinal99"))))
      ))
    (if (i32.or
          (call $dll_name_match (local.get $dll_name_ga) "WSOCK32.dll")
          (call $guest_name_is_ws2_32_ci (local.get $dll_name_ga)))
      (then
        (if (i32.eq (local.get $ordinal) (i32.const 115)) (then (return (call $lookup_api_id "WSAStartup"))))
        (if (i32.eq (local.get $ordinal) (i32.const 116)) (then (return (call $lookup_api_id "WSACleanup"))))
        (if (i32.eq (local.get $ordinal) (i32.const 111)) (then (return (call $lookup_api_id "WSAGetLastError"))))
        (if (i32.eq (local.get $ordinal) (i32.const 23))  (then (return (call $lookup_api_id "socket"))))
        (if (i32.eq (local.get $ordinal) (i32.const 3))   (then (return (call $lookup_api_id "closesocket"))))
        (if (i32.eq (local.get $ordinal) (i32.const 4))   (then (return (call $lookup_api_id "connect"))))
        (if (i32.eq (local.get $ordinal) (i32.const 19))  (then (return (call $lookup_api_id "send"))))
        (if (i32.eq (local.get $ordinal) (i32.const 16))  (then (return (call $lookup_api_id "recv"))))
        (if (i32.eq (local.get $ordinal) (i32.const 52))  (then (return (call $lookup_api_id "gethostbyname"))))
        (if (i32.eq (local.get $ordinal) (i32.const 9))   (then (return (call $lookup_api_id "htons"))))
        (if (i32.eq (local.get $ordinal) (i32.const 10))  (then (return (call $lookup_api_id "inet_addr"))))
        (if (i32.eq (local.get $ordinal) (i32.const 18))  (then (return (call $lookup_api_id "select"))))
        (if (i32.eq (local.get $ordinal) (i32.const 21))  (then (return (call $lookup_api_id "setsockopt"))))
        (if (i32.eq (local.get $ordinal) (i32.const 12))  (then (return (call $lookup_api_id "ioctlsocket"))))
        (if (i32.eq (local.get $ordinal) (i32.const 1))   (then (return (call $lookup_api_id "accept"))))
        (if (i32.eq (local.get $ordinal) (i32.const 2))   (then (return (call $lookup_api_id "bind"))))
        (if (i32.eq (local.get $ordinal) (i32.const 13))  (then (return (call $lookup_api_id "listen"))))
        (if (i32.eq (local.get $ordinal) (i32.const 22))  (then (return (call $lookup_api_id "shutdown"))))
        (if (i32.eq (local.get $ordinal) (i32.const 15))  (then (return (call $lookup_api_id "ntohs"))))
        (if (i32.eq (local.get $ordinal) (i32.const 11))  (then (return (call $lookup_api_id "inet_ntoa"))))
        (if (i32.eq (local.get $ordinal) (i32.const 151)) (then (return (call $lookup_api_id "__WSAFDIsSet"))))
        (if (i32.eq (local.get $ordinal) (i32.const 112)) (then (return (call $lookup_api_id "WSASetLastError"))))
        (if (i32.eq (local.get $ordinal) (i32.const 14))   (then (return (call $lookup_api_id "ntohl"))))
        (if (i32.eq (local.get $ordinal) (i32.const 5))    (then (return (call $lookup_api_id "getpeername"))))
        (if (i32.eq (local.get $ordinal) (i32.const 57))   (then (return (call $lookup_api_id "gethostname"))))
        (if (i32.eq (local.get $ordinal) (i32.const 101))  (then (return (call $lookup_api_id "WSAAsyncSelect"))))
        (if (i32.eq (local.get $ordinal) (i32.const 1001)) (then (return (call $lookup_api_id "WsControl"))))
      ))
    ;; WINMM. Welcome98 imports PlaySound purely by ordinal; the name is
    ;; resolved from the real Win98 winmm.dll export table rather than guessed
    ;; (tools/pe-exports.js --ordinal=2).
    (if (call $dll_name_match (local.get $dll_name_ga) "winmm.dll")
      (then
        (if (i32.eq (local.get $ordinal) (i32.const 2)) (then (return (call $lookup_api_id "PlaySoundA"))))
      ))
    ;; Authentic Win98 DPLAYX exports (ordinals read off the retail DX6
    ;; dplayx.dll with tools/pe-exports.js, not guessed). RollerCoaster Tycoon
    ;; imports 1 and 2 by ordinal only. $guest_name_is_static_system_dll
    ;; answers a *1-based* list position, and the list is
    ;; ole32/user32/comctl32/dplayx/ddraw/dsound/d3drm — so dplayx is 4 and
    ;; dsound is 6. The DSOUND rule below used to say 4 and therefore claimed
    ;; every dplayx ordinal: RCT's ordinal 2 came back as DirectSoundEnumerateA,
    ;; whose handler pushes four callback arguments where DirectPlayEnumerateA's
    ;; callback pops five (`ret 0x14`), and the resulting stack skew returned the
    ;; guest to EIP 0 before it ever created a window.
    (if (i32.eq (call $guest_name_is_static_system_dll (local.get $dll_name_ga))
                (i32.const 4))
      (then
        (if (i32.eq (local.get $ordinal) (i32.const 1)) (then (return (i32.const 1232)))) ;; DirectPlayCreate
        (if (i32.eq (local.get $ordinal) (i32.const 2)) (then (return (i32.const 1234)))) ;; DirectPlayEnumerateA
        (if (i32.eq (local.get $ordinal) (i32.const 4)) (then (return (i32.const 1235)))) ;; DirectPlayLobbyCreateA
        (if (i32.eq (local.get $ordinal) (i32.const 9)) (then (return (i32.const 1233)))) ;; DirectPlayEnumerate
      ))
    ;; Authentic Win98 DSOUND exports. Diablo II's D2Sound imports both by
    ;; ordinal: 2 enumerates the default driver, then 1 creates it. DSOUND is
    ;; entry 6 in STATIC_SYS_DLL_NAMES' 1-based numbering; those API ids are
    ;; append-only table positions and therefore as stable as the generated
    ;; dispatch itself.
    (if (i32.eq (call $guest_name_is_static_system_dll (local.get $dll_name_ga))
                (i32.const 6))
      (then
        (if (i32.eq (local.get $ordinal) (i32.const 1)) (then (return (i32.const 976))))  ;; DirectSoundCreate
        (if (i32.eq (local.get $ordinal) (i32.const 2)) (then (return (i32.const 1236)))) ;; DirectSoundEnumerateA
      ))
    ;; Authentic Win98 COMCTL32 ordinal 17 is InitCommonControls. InstallShield
    ;; setup helpers (including Heroes III's chkreqs.dll) import it without a
    ;; name. Match the module stem directly so a full path works as well.
    (if (call $guest_name_has_basename8_ci
          (local.get $dll_name_ga)
          (i32.const 0x63) (i32.const 0x6f) (i32.const 0x6d) (i32.const 0x63)
          (i32.const 0x74) (i32.const 0x6c) (i32.const 0x33) (i32.const 0x32)) ;; comctl32
      (then
        (if (i32.eq (local.get $ordinal) (i32.const 17))
          (then (return (i32.const 877)))) ;; InitCommonControls
      ))
    ;; OLEAUT32. Kodak Imaging imports the VARIANT/BSTR set by ordinal only.
    (if (call $dll_name_match (local.get $dll_name_ga) "oleaut32.dll")
      (then
        (if (i32.eq (local.get $ordinal) (i32.const 2))  (then (return (call $lookup_api_id "SysAllocString"))))
        (if (i32.eq (local.get $ordinal) (i32.const 4))  (then (return (call $lookup_api_id "SysAllocStringLen"))))
        (if (i32.eq (local.get $ordinal) (i32.const 6))  (then (return (call $lookup_api_id "SysFreeString"))))
        (if (i32.eq (local.get $ordinal) (i32.const 7))  (then (return (call $lookup_api_id "SysStringLen"))))
        (if (i32.eq (local.get $ordinal) (i32.const 8))  (then (return (call $lookup_api_id "VariantInit"))))
        (if (i32.eq (local.get $ordinal) (i32.const 9))  (then (return (call $lookup_api_id "VariantClear"))))
        (if (i32.eq (local.get $ordinal) (i32.const 10)) (then (return (call $lookup_api_id "VariantCopy"))))
        (if (i32.eq (local.get $ordinal) (i32.const 420)) (then (return (call $lookup_api_id "OleCreateFontIndirect"))))
      ))
    (i32.const -1))

  ;; Resolve one ordinal-only import. The WAT table above is consulted
  ;; first, so a DLL described there behaves the same whether the EXE or
  ;; another DLL imports it — the two loaders previously each had their own
  ;; answer, and a name present in one was missing from the other. The host
  ;; map still covers the DLLs whose ordinals have not moved into WAT.
  ;; $dll_name_ga is a guest address (what $dll_name_match reads through);
  ;; $dll_name_wa is the same string as a linear-memory address, which is
  ;; what the host import expects.
  (func $resolve_import_ordinal (param $dll_name_ga i32) (param $dll_name_wa i32)
                                (param $ordinal i32) (result i32)
    (local $id i32)
    (local.set $id (call $system_ordinal_api_id
      (local.get $dll_name_ga) (local.get $ordinal)))
    (if (i32.ne (local.get $id) (i32.const -1)) (then (return (local.get $id))))
    (call $host_resolve_ordinal (local.get $dll_name_wa) (local.get $ordinal)))

  ;; Process a loaded DLL's imports — create thunks for system DLLs,
  ;; resolve against other loaded DLLs if found.
  (func $process_dll_imports (param $load_addr i32) (param $import_rva i32)
    (local $desc_ptr i32) (local $ilt_rva i32) (local $iat_rva i32)
    (local $ilt_ptr i32) (local $iat_ptr i32) (local $entry i32) (local $thunk_addr i32)
    (local $dll_name_rva i32) (local $dll_name_ptr i32)
    (local $resolved_dll i32) (local $resolved_addr i32) (local $api_id i32) (local $hint_name_wa i32)
    (local.set $desc_ptr (call $g2w (i32.add (local.get $load_addr) (local.get $import_rva))))
    (block $id (loop $dl
      (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
      (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))
      ;; OriginalFirstThunk is optional. As in the main PE loader, a stripped
      ;; image keeps its lookup entries in FirstThunk until we overwrite them.
      ;; FirstThunk is required for a live descriptor, so use it to recognize
      ;; the terminator and as the lookup-table fallback.
      (br_if $id (i32.eqz (local.get $iat_rva)))
      (if (i32.eqz (local.get $ilt_rva))
        (then (local.set $ilt_rva (local.get $iat_rva))))
      ;; Get imported DLL name
      (local.set $dll_name_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 12))))
      (local.set $dll_name_ptr (i32.add (local.get $load_addr) (local.get $dll_name_rva)))
      ;; Check if this DLL is loaded — search DLL_TABLE
      (local.set $resolved_dll (call $find_loaded_dll (local.get $dll_name_ptr)))
      (local.set $ilt_ptr (call $g2w (i32.add (local.get $load_addr) (local.get $ilt_rva))))
      (local.set $iat_ptr (call $g2w (i32.add (local.get $load_addr) (local.get $iat_rva))))
      (block $fd (loop $fl
        (local.set $entry (i32.load (local.get $ilt_ptr)))
        (br_if $fd (i32.eqz (local.get $entry)))
        (if (i32.ge_s (local.get $resolved_dll) (i32.const 0))
          (then
            ;; Resolve against loaded DLL
            (if (i32.and (local.get $entry) (i32.const 0x80000000))
              (then
                ;; Ordinal import
                (local.set $resolved_addr (call $resolve_ordinal (local.get $resolved_dll)
                  (i32.and (local.get $entry) (i32.const 0xFFFF)))))
              (else
                ;; Name import — get name from hint/name table
                (local.set $resolved_addr (call $resolve_name_export (local.get $resolved_dll)
                  (call $g2w (i32.add (local.get $load_addr) (i32.add (local.get $entry) (i32.const 2))))))))
            (i32.store (local.get $iat_ptr) (local.get $resolved_addr)))
          (else
            ;; System DLL — create thunk. LoadLibrary can run on any guest
            ;; thread, so the index comes from the process-wide cursor rather
            ;; than this instance's count (see $thunk_reserve).
            (global.set $num_thunks (call $thunk_reserve))
            (local.set $thunk_addr (i32.add
              (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                       (global.get $GUEST_BASE))
              (global.get $image_base)))
            (i32.store (local.get $iat_ptr) (local.get $thunk_addr))
            (if (i32.eqz (i32.and (local.get $entry) (i32.const 0x80000000)))
              (then
                (local.set $hint_name_wa
                  (call $g2w (i32.add (local.get $load_addr) (local.get $entry))))
                (local.set $api_id (call $import_hint_override_api_id
                  (local.get $dll_name_ptr)
                  (local.get $hint_name_wa)))
                (if (i32.ne (local.get $api_id) (i32.const -1))
                  (then
                    (i32.store
                      (i32.add (global.get $THUNK_BASE)
                        (i32.mul (global.get $num_thunks) (i32.const 8)))
                      (i32.or (i32.const 0x80000000)
                        (i32.load16_u (local.get $hint_name_wa))))
                    (i32.store
                      (i32.add
                        (i32.add (global.get $THUNK_BASE)
                          (i32.mul (global.get $num_thunks) (i32.const 8)))
                        (i32.const 4))
                      (local.get $api_id)))
                  (else
                    ;; Name import: store name RVA relative to guest base.
                    ;; The name is at load_addr + entry, but thunk expects RVA
                    ;; from image_base.
                    (i32.store
                      (i32.add (global.get $THUNK_BASE)
                        (i32.mul (global.get $num_thunks) (i32.const 8)))
                      (i32.sub (i32.add (local.get $load_addr) (local.get $entry))
                        (global.get $image_base)))
                    (i32.store
                      (i32.add
                        (i32.add (global.get $THUNK_BASE)
                          (i32.mul (global.get $num_thunks) (i32.const 8)))
                        (i32.const 4))
                      (call $lookup_api_id
                        (call $g2w
                          (i32.add (local.get $load_addr)
                            (i32.add (local.get $entry) (i32.const 2)))))))))
              (else
                ;; A DLL import needs the same WAT-first, host-fallback ordinal
                ;; resolver as the main executable.  Calling only the static
                ;; WAT table here made host-mapped system exports (notably the
                ;; authentic DPLAYX ordinal set) turn into ORD diagnostics
                ;; when imported by a loaded DLL, even though the identical
                ;; import from an EXE resolved correctly.
                (local.set $api_id (call $resolve_import_ordinal
                  (local.get $dll_name_ptr)
                  (call $g2w (local.get $dll_name_ptr))
                  (i32.and (local.get $entry) (i32.const 0xFFFF))))
                (if (i32.ne (local.get $api_id) (i32.const -1))
                  (then
                    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                      (i32.or (i32.const 0x80000000) (i32.and (local.get $entry) (i32.const 0xFFFF))))
                    (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
                      (local.get $api_id)))
                  (else
                    ;; Unknown ordinal: retain a clear diagnostic instead of
                    ;; treating the raw ordinal as an API-table index.
                    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                      (i32.const 0x4F524400)) ;; "ORD\0" marker
                    (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
                      (i32.and (local.get $entry) (i32.const 0xFFFF)))))))
            (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
            (call $update_thunk_end)))
        (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
        (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
        (br $fl)))
      (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
      (br $dl))))

  ;; Find a loaded DLL by name (guest address of name string).
  ;; Returns dll_idx (0-based) or -1 if not found.
  ;; Compares against DLL export names stored in export directory.
  (func $find_loaded_dll (param $name_ptr i32) (result i32)
    (local $i i32) (local $tbl_ptr i32) (local $la i32) (local $exp_rva i32)
    (local $exp_name_rva i32) (local $exp_name_wa i32)
    (local.set $i (i32.const 0))
    (block $notfound (loop $search
      (br_if $notfound (i32.ge_u (local.get $i) (global.get $dll_count)))
      (local.set $tbl_ptr (i32.add (global.get $DLL_TABLE) (i32.mul (local.get $i) (i32.const 32))))
      (local.set $la (i32.load (local.get $tbl_ptr)))
      (local.set $exp_rva (i32.load (i32.add (local.get $tbl_ptr) (i32.const 8))))
      (if (i32.ne (local.get $exp_rva) (i32.const 0))
        (then
          ;; Get export directory name RVA
          (local.set $exp_name_rva (i32.load (i32.add (call $g2w (i32.add (local.get $la) (local.get $exp_rva))) (i32.const 12))))
          (local.set $exp_name_wa (call $g2w (i32.add (local.get $la) (local.get $exp_name_rva))))
          ;; Compare (case-insensitive)
          (if (call $dll_name_match (local.get $name_ptr) (local.get $exp_name_wa))
            (then (return (local.get $i))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $search)))
    (i32.const -1))

  ;; Patch a caller's imports for a specific loaded DLL.
  ;; Walks the caller's import descriptor and resolves against DLL exports.
  (func $patch_caller_iat (export "patch_caller_iat")
    (param $caller_base i32) (param $caller_import_rva i32)
    (param $target_dll_name_ptr i32) (param $dll_idx i32)
    (local $desc_ptr i32) (local $ilt_rva i32) (local $iat_rva i32)
    (local $dll_name_rva i32) (local $dll_name_ga i32)
    (local $ilt_ptr i32) (local $iat_ptr i32) (local $entry i32)
    (local $resolved i32) (local $name_wa i32) (local $api_id i32) (local $thunk_addr i32)
    (local.set $desc_ptr (call $g2w (i32.add (local.get $caller_base) (local.get $caller_import_rva))))
    (block $id (loop $dl
      (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
      (br_if $id (i32.eqz (local.get $ilt_rva)))
      ;; Check if this descriptor's DLL name matches
      (local.set $dll_name_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 12))))
      (local.set $dll_name_ga (i32.add (local.get $caller_base) (local.get $dll_name_rva)))
      (if (call $dll_name_match (local.get $dll_name_ga) (call $g2w (local.get $target_dll_name_ptr)))
        (then
          ;; Found matching descriptor — patch all IAT entries
          (local.set $ilt_ptr (call $g2w (i32.add (local.get $caller_base) (local.get $ilt_rva))))
          (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))
          (local.set $iat_ptr (call $g2w (i32.add (local.get $caller_base) (local.get $iat_rva))))
          (block $fd (loop $fl
            (local.set $entry (i32.load (local.get $ilt_ptr)))
            (br_if $fd (i32.eqz (local.get $entry)))
            (if (i32.and (local.get $entry) (i32.const 0x80000000))
              (then
                ;; Ordinal import
                (local.set $resolved (call $resolve_ordinal (local.get $dll_idx)
                  (i32.and (local.get $entry) (i32.const 0xFFFF)))))
              (else
                ;; Name import
                (local.set $name_wa
                  (call $g2w (i32.add (local.get $caller_base) (i32.add (local.get $entry) (i32.const 2)))))
                (local.set $api_id (call $native_override_export_api_id (local.get $name_wa)))
                (if (i32.ne (local.get $api_id) (i32.const -1))
                  (then
                    ;; Same reservation as above: this patching path runs
                    ;; whenever a DLL loads, on whichever thread loaded it.
                    (global.set $num_thunks (call $thunk_reserve))
                    (local.set $thunk_addr (i32.add
                      (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                               (global.get $GUEST_BASE))
                      (global.get $image_base)))
                    (i32.store (local.get $iat_ptr) (local.get $thunk_addr))
                    (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                      (i32.sub (i32.add (local.get $caller_base) (local.get $entry)) (global.get $image_base)))
                    (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
                      (local.get $api_id))
                    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
                    (call $update_thunk_end)
                    (local.set $resolved (i32.const 0)))
                  (else
                    (local.set $resolved
                      (call $resolve_name_export (local.get $dll_idx) (local.get $name_wa)))))))
            (if (local.get $resolved)
              (then (i32.store (local.get $iat_ptr) (local.get $resolved))))
            (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
            (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
            (br $fl)))))
      (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
      (br $dl))))

  ;; Get next available DLL load address (page-aligned after last DLL AND after heap)
  ;; Named as well as exported: WAT-side callers load DLLs too. The WinHelp
  ;; engine loads a help file's own DLL when a registered macro is called,
  ;; without a round trip through the host.
  (func $next_dll_addr (export "get_next_dll_addr") (result i32)
    (local $addr i32) (local $after_dll i32) (local $mark i32)
    (if (global.get $dll_count)
      (then
        ;; After last loaded DLL
        (local.set $addr (i32.add (global.get $DLL_TABLE) (i32.mul (i32.sub (global.get $dll_count) (i32.const 1)) (i32.const 32))))
        (local.set $after_dll (i32.and
          (i32.add (i32.add (i32.load (local.get $addr)) (i32.load (i32.add (local.get $addr) (i32.const 4)))) (i32.const 0xFFF))
          (i32.const 0xFFFFF000))))
      (else
        ;; First DLL: after EXE's SizeOfImage
        (local.set $after_dll (i32.and
          (i32.add (i32.add (global.get $image_base) (global.get $exe_size_of_image)) (i32.const 0xFFF))
          (i32.const 0xFFFFF000)))))
    ;; Return max(after_dll, page_aligned(low-heap watermark)) to avoid
    ;; overwriting the heap. The watermark is the top of every instance's
    ;; reserved arena, which is what has to be cleared — one instance's
    ;; $heap_ptr would say nothing about the others'.
    (local.set $mark (call $heap_low_watermark))
    (if (result i32) (i32.gt_u (local.get $mark) (local.get $after_dll))
      (then (i32.and (i32.add (local.get $mark) (i32.const 0xFFF)) (i32.const 0xFFFFF000)))
      (else (local.get $after_dll))))

  (func (export "get_exe_size_of_image") (result i32) (global.get $exe_size_of_image))
  (func (export "get_dll_count") (result i32) (global.get $dll_count))
  (func (export "get_dll_capacity") (result i32) (global.get $DLL_TABLE_CAPACITY))
