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
    (local $entry_rva i32) (local $characteristics i32)
    (local $dll_idx i32) (local $tbl_ptr i32)
    (local $src i32) (local $dst i32)

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
      (if (i32.gt_u (local.get $raw_size) (i32.const 0))
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

    ;; Parse export directory
    (if (i32.ne (local.get $export_rva) (i32.const 0))
      (then (call $parse_exports (local.get $tbl_ptr) (local.get $load_addr) (local.get $export_rva))))

    ;; Process DLL's own imports (resolve to our thunks)
    (if (i32.ne (local.get $import_rva) (i32.const 0))
      (then (call $process_dll_imports (local.get $load_addr) (local.get $import_rva))))

    (global.set $dll_count (i32.add (global.get $dll_count) (i32.const 1)))

    ;; Advance heap_ptr past loaded DLL so heap doesn't overlap DLL memory
    (local.set $dst (i32.and
      (i32.add (i32.add (local.get $load_addr)
        (i32.load (i32.add (local.get $pe_off) (i32.const 80)))) ;; SizeOfImage
        (i32.const 0xFFF))
      (i32.const 0xFFFFF000)))
    (if (i32.gt_u (local.get $dst) (global.get $heap_ptr))
      (then (global.set $heap_ptr (local.get $dst))))

    ;; Return DllMain entry point
    (if (result i32) (i32.ne (local.get $entry_rva) (i32.const 0))
      (then (i32.add (local.get $load_addr) (local.get $entry_rva)))
      (else (i32.const 0))))

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

  ;; Process a loaded DLL's imports — create thunks for system DLLs,
  ;; resolve against other loaded DLLs if found.
  (func $process_dll_imports (param $load_addr i32) (param $import_rva i32)
    (local $desc_ptr i32) (local $ilt_rva i32) (local $iat_rva i32)
    (local $ilt_ptr i32) (local $iat_ptr i32) (local $entry i32) (local $thunk_addr i32)
    (local $dll_name_rva i32) (local $dll_name_ptr i32)
    (local $resolved_dll i32) (local $resolved_addr i32)
    (local.set $desc_ptr (call $g2w (i32.add (local.get $load_addr) (local.get $import_rva))))
    (block $id (loop $dl
      (local.set $ilt_rva (i32.load (local.get $desc_ptr)))
      (local.set $iat_rva (i32.load (i32.add (local.get $desc_ptr) (i32.const 16))))
      (br_if $id (i32.eqz (local.get $ilt_rva)))
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
            ;; System DLL — create thunk
            (local.set $thunk_addr (i32.add
              (i32.sub (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                       (global.get $GUEST_BASE))
              (global.get $image_base)))
            (i32.store (local.get $iat_ptr) (local.get $thunk_addr))
            (if (i32.eqz (i32.and (local.get $entry) (i32.const 0x80000000)))
              (then
                ;; Name import: store name RVA relative to guest base
                ;; The name is at load_addr + entry, but thunk expects RVA from image_base
                ;; Compute: (load_addr + entry) - image_base = RVA for thunk
                (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                  (i32.sub (i32.add (local.get $load_addr) (local.get $entry)) (global.get $image_base)))
                (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
                  (call $lookup_api_id (call $g2w (i32.add (local.get $load_addr) (i32.add (local.get $entry) (i32.const 2)))))))
              (else
                ;; Ordinal import — store marker and ordinal (will hit fallback)
                (i32.store (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8)))
                  (i32.const 0x4F524400)) ;; "ORD\0" marker
                (i32.store (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (global.get $num_thunks) (i32.const 8))) (i32.const 4))
                  (i32.const 0xFFFF))))
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
    (local $resolved i32)
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
                (local.set $resolved (call $resolve_name_export (local.get $dll_idx)
                  (call $g2w (i32.add (local.get $caller_base) (i32.add (local.get $entry) (i32.const 2))))))))
            (if (local.get $resolved)
              (then (i32.store (local.get $iat_ptr) (local.get $resolved))))
            (local.set $ilt_ptr (i32.add (local.get $ilt_ptr) (i32.const 4)))
            (local.set $iat_ptr (i32.add (local.get $iat_ptr) (i32.const 4)))
            (br $fl)))))
      (local.set $desc_ptr (i32.add (local.get $desc_ptr) (i32.const 20)))
      (br $dl))))

  ;; Get next available DLL load address (page-aligned after EXE + heap margin)
  (func (export "get_next_dll_addr") (result i32)
    (local $addr i32)
    (if (result i32) (global.get $dll_count)
      (then
        ;; After last loaded DLL
        (local.set $addr (i32.add (global.get $DLL_TABLE) (i32.mul (i32.sub (global.get $dll_count) (i32.const 1)) (i32.const 32))))
        ;; load_addr + size_of_image, page-aligned
        (i32.and
          (i32.add (i32.add (i32.load (local.get $addr)) (i32.load (i32.add (local.get $addr) (i32.const 4)))) (i32.const 0xFFF))
          (i32.const 0xFFFFF000)))
      (else
        ;; First DLL: after EXE's SizeOfImage
        (i32.and
          (i32.add (i32.add (global.get $image_base) (global.get $exe_size_of_image)) (i32.const 0xFFF))
          (i32.const 0xFFFFF000)))))

  (func (export "get_exe_size_of_image") (result i32) (global.get $exe_size_of_image))
  (func (export "get_dll_count") (result i32) (global.get $dll_count))
