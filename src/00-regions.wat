  ;; ============================================================
  ;; src/00-regions.wat — THE fixed memory map, declared.
  ;;
  ;; Milestone 6 step 1 of docs/watx-migration-plan.md; designed in
  ;; docs/watx-region-safety-design.md.
  ;;
  ;; Every entry states where a fixed region IS. `region.declare-fixed` is the
  ;; one head in the WATX region family that does not allocate: the base is an
  ;; input, and the compiler verifies it. That matters here because these bases
  ;; are an ABI — lib/mem-utils.js, lib/guest-rpc.js, lib/host-imports.js,
  ;; lib/thread-manager.js, test/run.js, every g2w translation and a pile of
  ;; tests all hold copies of them. Nothing in this file may ever MOVE a region.
  ;;
  ;; What the compiler now proves, on every build, in both modes:
  ;;   - no two declared regions overlap (a deliberate nesting says (within $R))
  ;;   - every base meets its declared alignment
  ;;   - no region runs past the memory that exists at instantiation
  ;;   - no region is declared twice
  ;; and, at any use site that adopts them, that a constant offset is inside its
  ;; region — (region.addr $R 0x40), which emits exactly the i32.const the raw
  ;; hex literal emits.
  ;;
  ;; DECLARATIONS EMIT NOTHING. This whole file adds zero bytes to the shipped
  ;; wasm: a declaration is compile-time-only under WATX, and the canonical
  ;; artifacts were byte-identical with and without it when the set landed
  ;; (tail 984347 B 01daf6ccfbd115e3, compat 984796 B 0ee6414668129ac4).
  ;; The `WINE_WAT_COMPILER=legacy` rollback that used to be quoted here is
  ;; RETIRED (24b79256, docs/watx-region-safety-design.md §11): declarations
  ;; alone were legacy-safe, but the region spellings the tree now uses in
  ;; expression and data position compile to `unreachable` under the legacy
  ;; path, so it is a hard error rather than a second opinion.
  ;;
  ;; RELATIONSHIP TO THE EXISTING GLOBALS. Each declaration mirrors a
  ;; `(global $NAME i32 ...)` / `(global $NAME_SIZE i32 ...)` pair, which is
  ;; still what the code reads and what tools/wat-memory-map.js and
  ;; test/test-wat-memory-map.js derive their map from.
  ;; tools/check-region-decls.js holds the two in step and fails the build on
  ;; any disagreement, so this file cannot rot into a decorative second opinion.
  ;; `(owner ...)` names the source location of the base global.
  ;;
  ;; Converting consumers to address regions by name is Milestone 6 stage B and
  ;; is UNDER WAY: wave 1 (2026-08-31) symbolized ~96 sites across src/ and
  ;; lib/, and wave 2 added the regions this map was missing entirely. So both
  ;; `$NAME` in expression position and `(data (region.addr $NAME OFF) ...)`
  ;; now appear in src/ — see docs/watx-region-safety-design.md §5 and §13.
  ;;
  ;; TO ADD A REGION: declare its $NAME/$NAME_SIZE globals where the feature
  ;; lives, as before, then add the mirror here. The build fails if you skip it
  ;; or get it wrong, which is the entire point.
  ;; ============================================================

  ;; The low string-constant pool and the MapVirtualKey byte tables. Neither
  ;; had a _SIZE global, so neither was visible to wat-memory-map.js or to any
  ;; overlap gate; 57 data segments lived here in no region at all.
  (region.declare-fixed $STRING_CONSTANTS (base 0x00000100) (size 0x00000280) (align 0x00000100)
    (owner "01-header.wat:882"))
  (region.declare-fixed $VK_SCAN_TABLES (base 0x00000380) (size 0x00000080) (align 0x00000080)
    (owner "09a7-handlers-dispatch.wat:1944"))
  (region.declare-fixed $UPDATE_RECT (base 0x00002000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1647"))
  (region.declare-fixed $UPDATE_FLAGS (base 0x00003000) (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:1649"))
  ;; WIDENED 0x80 -> 0x1A0 (wave 2). The declaration covered only as far as
  ;; "SysLink"; the class-name block runs to the RGB555 masks at 0x32A0, so
  ;; everything past 0x3180 -- the DirectAnimation names, SysTreeView32, the
  ;; statusbar/toolbar classes -- sat outside every region and outside every
  ;; gate. The three blocks that follow used to be undeclared data segments.
  (region.declare-fixed $CLASS_NAME_STRINGS (base 0x00003100) (size 0x000001A0) (align 0x00000100)
    (owner "01-header.wat:1658"))
  (region.declare-fixed $DIB_DEFAULT_RGB555_MASKS (base 0x000032A0) (size 0x0000000C) (align 0x00000010)
    (owner "01-header.wat:1214"))
  (region.declare-fixed $OLE_STRINGS (base 0x000032B0) (size 0x000000E0) (align 0x00000010)
    (owner "01-header.wat:1222"))
  (region.declare-fixed $ENV_DEFAULTS (base 0x00003390) (size 0x000000C0) (align 0x00000010)
    (owner "01-header.wat:1252"))
  (region.declare-fixed $WND_BG_BRUSH_TABLE (base 0x00003500) (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1635"))
  (region.declare-fixed $WND_CLASS_CURSOR_TABLE (base 0x00003900) (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1643"))
  (region.declare-fixed $CLASS_EXTRA_TABLE (base 0x00003D00) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1793"))
  ;; The two Win16 name tables in the hole after CLASS_EXTRA_TABLE. Both were
  ;; raw (data (i32.const ...)) segments in no region at all; each is sized to
  ;; exactly the bytes its segment emits, so growing one is a compile error.
  (region.declare-fixed $WIN16_FONT_FACES (base 0x00003E00) (size 0x00000030) (align 0x00000100)
    (owner "09e-win16-api.wat:9232"))
  (region.declare-fixed $WIN16_MMSYSTEM_NAMES (base 0x00003E30) (size 0x0000005D) (align 0x00000010)
    (owner "09e-win16-api.wat:10008"))
  (region.declare-fixed $DIALOG_STATE_TABLE (base 0x00004000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:2113"))
  (region.declare-fixed $WINDOW_UNICODE_TABLE (base 0x00005000) (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:2115"))
  (region.declare-fixed $SHARED_PROCESS_ID (base 0x00005100) (size 0x00000004) (align 0x00000100)
    (owner "01-header.wat:2119"))
  (region.declare-fixed $SHARED_DLG_ENDED (base 0x00005104) (size 0x00000004)
    (owner "01-header.wat:2961"))
  (region.declare-fixed $SHARED_DLG_RESULT (base 0x00005108) (size 0x00000004)
    (owner "01-header.wat:2963"))
  (region.declare-fixed $SHARED_DLG_PUMP_HWND (base 0x0000510C) (size 0x00000004)
    (owner "01-header.wat:2972"))
  ;; Host-supplied environment overrides. The 240-byte extent is the bound
  ;; $test_launch_env_add already enforced as a bare literal; it now reads the
  ;; region's own size, so the two cannot disagree.
  (region.declare-fixed $LAUNCH_ENV_OVERRIDES (base 0x00005110) (size 0x000000F0) (align 0x00000010)
    (owner "01-header.wat:2991"))
  (region.declare-fixed $WINDOW_EXTRA_TABLE (base 0x00005200) (size 0x00001000) (align 0x00000100)
    (owner "01-header.wat:2124"))
  (region.declare-fixed $PAINT_SCRATCH (base 0x00006E00) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2049"))
  (region.declare-fixed $WND_CLASS_SLOT_TABLE (base 0x00006F00) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1788"))
  (region.declare-fixed $WND_RECORDS (base 0x00007000) (size 0x00001800) (align 0x00001000)
    (owner "01-header.wat:1630"))
  (region.declare-fixed $CONTROL_TABLE (base 0x00008800) (size 0x00001000) (align 0x00000100)
    (owner "01-header.wat:2010"))
  (region.declare-fixed $CONTROL_GEOM (base 0x00009800) (size 0x00000800) (align 0x00000100)
    (owner "01-header.wat:2017"))
  (region.declare-fixed $CLASS_RECORDS (base 0x0000A000) (size 0x00000C00) (align 0x00001000)
    (owner "01-header.wat:2034"))
  (region.declare-fixed $TIMER_TABLE (base 0x0000AC00) (size 0x00000140) (align 0x00000100)
    (owner "01-header.wat:2752"))
  (region.declare-fixed $MENU_DATA_TABLE (base 0x0000AD60) (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2088"))
  (region.declare-fixed $WND_DLG_RECORDS (base 0x0000B160) (size 0x00002000) (align 0x00000010)
    (owner "01-header.wat:2105"))
  ;; Four dwords of cross-instance waveOut identity in the 16-byte hole
  ;; between WND_DLG_RECORDS and SCROLL_TABLE. Declared rather than spelled
  ;; (region.end $WND_DLG_RECORDS): it is its own object, and an adjacency is
  ;; not an address (docs/watx-region-safety-design.md 5.1).
  (region.declare-fixed $WAVE_OUT_SHARED (base 0x0000D160) (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:2578"))
  (region.declare-fixed $SCROLL_TABLE (base 0x0000D170) (size 0x00001800) (align 0x00000010)
    (owner "01-header.wat:2138"))
  (region.declare-fixed $FLASH_TABLE (base 0x0000E970) (size 0x00000100) (align 0x00000010)
    (owner "01-header.wat:2156"))
  (region.declare-fixed $NC_FLAGS (base 0x0000EA70) (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:1653"))
  (region.declare-fixed $TITLE_TABLE (base 0x0000EE70) (size 0x00000800) (align 0x00000010)
    (owner "01-header.wat:1679"))
  (region.declare-fixed $CLIENT_RECT (base 0x0000F670) (size 0x00001000) (align 0x00000010)
    (owner "01-header.wat:2006"))
  (region.declare-fixed $SHOW_STATE_TABLE (base 0x00010670) (size 0x00000100) (align 0x00000010)
    (owner "01-header.wat:2167"))
  (region.declare-fixed $WINDOW_REGION_BITS (base 0x00010770) (size 0x00000020) (align 0x00000010)
    (owner "01-header.wat:2173"))
  (region.declare-fixed $NATIVE_STATUS_BITS (base 0x00010790) (size 0x00000020) (align 0x00000010)
    (owner "01-header.wat:2023"))
  (region.declare-fixed $NATIVE_TAB_BITS (base 0x000107B0) (size 0x00000020) (align 0x00000010)
    (owner "01-header.wat:2027"))
  (region.declare-fixed $SHARED_MODAL_DLG_HWND (base 0x000107D0) (size 0x00000004) (align 0x00000010)
    (owner "01-header.wat:2979"))
  (region.declare-fixed $SHARED_MODAL_RESULT (base 0x000107D4) (size 0x00000004)
    (owner "01-header.wat:2981"))
  (region.declare-fixed $SHARED_MODAL_DONE (base 0x000107D8) (size 0x00000004)
    (owner "01-header.wat:2983"))
  (region.declare-fixed $CS_RING (base 0x00010900) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2401"))
  (region.declare-fixed $MCI_DEVICE_TABLE (base 0x00010A00) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1686"))
  (region.declare-fixed $OWNER_TABLE (base 0x00010B00) (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1691"))
  ;; The reserved page just below GUEST_BASE. Four undeclared string blocks
  ;; interleaved with the declared tables that already lived here; each is
  ;; bounded by the next declared region, so the extents are not guesses.
  (region.declare-fixed $USER_DIALOG_STRINGS (base 0x00011000) (size 0x00000270) (align 0x00001000)
    (owner "01-header.wat:1133"))
  (region.declare-fixed $DX_VERSION_INFO (base 0x00011270) (size 0x0000005C) (align 0x00000010)
    (owner "01-header.wat:3457"))
  (region.declare-fixed $ORDINAL_NAMES_WSOCK32 (base 0x00011300) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:968"))
  (region.declare-fixed $DI_DIK_VK_TABLE (base 0x00011400) (size 0x00000100) (align 0x00000100)
    (owner "09a8-handlers-directx.wat:6309"))
  (region.declare-fixed $ORDINAL_NAMES_OLEAUT32 (base 0x00011500) (size 0x00000080) (align 0x00000100)
    (owner "01-header.wat:988"))
  (region.declare-fixed $RICHEDIT_FORMAT_TABLE (base 0x00011580) (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2178"))
  (region.declare-fixed $RICHEDIT_PARA_TABLE (base 0x00011980) (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2182"))
  (region.declare-fixed $RESERVED_PAGE_STRINGS (base 0x00011D80) (size 0x00000280) (align 0x00000080)
    (owner "01-header.wat:1002"))
  (region.declare-fixed $GUEST_BASE (base 0x00012000) (size 0x03C00000) (align 0x00001000)
    (owner "01-header.wat:1449"))
  (region.declare-fixed $GUEST_HEAP_BASE (base 0x03D12000) (size 0x00100000) (align 0x00001000)
    (owner "01-header.wat:1453"))
  (region.declare-fixed $HANDLER_PAIR_HIST_COUNTS (base 0x04000000) (size 0x00100000) (align 0x00001000)
    (owner "01-header.wat:1986"))
  (region.declare-fixed $PAGE_INDEX_ARENA (base 0x04100000) (size 0x00800000) (align 0x00001000)
    (owner "01-header.wat:1483"))
  (region.declare-fixed $PAGE_DIR_BASE (base 0x04900000) (size 0x00020000) (align 0x00001000)
    (owner "01-header.wat:1496"))
  (region.declare-fixed $WIN16_APP_DLL_STAGING (base 0x04A00000) (size 0x00600000) (align 0x00001000)
    (owner "01-header.wat:3356"))
  (region.declare-fixed $THREAD_CACHE_BASE (base 0x05000000) (size 0x02000000) (align 0x00001000)
    (owner "01-header.wat:1458"))
  (region.declare-fixed $GUEST_STACK (base 0x07012000) (size 0x00100000) (align 0x00001000)
    (owner "01-header.wat:1451"))
  (region.declare-fixed $THUNK_BASE (base 0x07112000) (size 0x00040000) (align 0x00001000)
    (owner "01-header.wat:1455"))
  (region.declare-fixed $PE_STAGING (base 0x07192000) (size 0x00800000) (align 0x00001000)
    (owner "01-header.wat:1447"))
  (region.declare-fixed $DLL_TABLE (base 0x07992000) (size 0x00000200) (align 0x00001000)
    (owner "01-header.wat:2618"))
  (region.declare-fixed $DLL_RSRC_TABLE (base 0x07992200) (size 0x00000080) (align 0x00000100)
    (owner "01-header.wat:2620"))
  (region.declare-fixed $DLL_PATH_TABLE (base 0x07992300) (size 0x00000040) (align 0x00000100)
    (owner "01-header.wat:2623"))
  (region.declare-fixed $GDI_BITMAP_TEXT_LAYOUT (base 0x07993000) (size 0x00021000) (align 0x00001000)
    (owner "10b-gdi-font.wat:1971"))
  (region.declare-fixed $GDI_BITMAP_TEXT_PREFIX (base 0x079B4000) (size 0x00011000) (align 0x00001000)
    (owner "10b-gdi-font.wat:1974"))
  (region.declare-fixed $WND_Z_ORDER_TABLE (base 0x079C8000) (size 0x00000400) (align 0x00001000)
    (owner "01-header.wat:1756"))
  (region.declare-fixed $WND_CLASS_ICON_TABLE (base 0x079C9000) (size 0x00000400) (align 0x00001000)
    (owner "01-header.wat:1704"))
  (region.declare-fixed $WIN16_FILE_TABLE (base 0x079C9400) (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1767"))
  (region.declare-fixed $WND_OWN_DC_TABLE (base 0x079C9800) (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1716"))
  (region.declare-fixed $WND_HINSTANCE_TABLE (base 0x079C9C00) (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1751"))
  (region.declare-fixed $WIN16_BUILTIN_NAMES (base 0x079CA000) (size 0x00000200) (align 0x00001000)
    (owner "09e-win16-api.wat:10005"))
  (region.declare-fixed $WND_THREAD_TABLE (base 0x079CC400) (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1726"))
  (region.declare-fixed $THREAD_MSG_QUEUES (base 0x079CC800) (size 0x00002080) (align 0x00000100)
    (owner "01-header.wat:1737"))
  (region.declare-fixed $GDI_NEAREST_CACHE (base 0x079D0000) (size 0x00008000) (align 0x00001000)
    (owner "10g-gdi-raster.wat:3820"))
  (region.declare-fixed $WIN16_THUNK_TABLE (base 0x079D8000) (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:3242"))
  (region.declare-fixed $WIN16_SEG_TABLE (base 0x079DA000) (size 0x00004000) (align 0x00001000)
    (owner "01-header.wat:3233"))
  (region.declare-fixed $API_HASH_TABLE (base 0x07E00000) (size 0x00008000) (align 0x00001000)
    (owner "01-header.wat:1615"))
  (region.declare-fixed $TEXT_SCRATCH (base 0x07E08000) (size 0x00000400) (align 0x00001000)
    (owner "01-header.wat:3173"))
  (region.declare-fixed $CONSOLE_TEXT (base 0x07E09000) (size 0x00003000) (align 0x00001000)
    (owner "01-header.wat:3179"))
  (region.declare-fixed $CONSOLE_ATTR (base 0x07E0C000) (size 0x00003000) (align 0x00001000)
    (owner "01-header.wat:3181"))
  (region.declare-fixed $CONSOLE_INPUT (base 0x07E0F000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:3198"))
  (region.declare-fixed $DIB_PAGE_USED (base 0x07E10000) (size 0x00004000) (align 0x00001000)
    (owner "01-header.wat:2352"))
  (region.declare-fixed $DIB_PAGE_RUNS (base 0x07E14000) (size 0x00008000) (align 0x00001000)
    (owner "01-header.wat:2354"))
  (region.declare-fixed $GDI_REGION_BANDS (base 0x07E1C000) (size 0x000D0000) (align 0x00001000)
    (owner "01-header.wat:1818"))
  (region.declare-fixed $GDI_REGION_WORK (base 0x07EEC000) (size 0x00003400) (align 0x00001000)
    (owner "01-header.wat:1820"))
  (region.declare-fixed $GDI_DC_CLIP_TABLE (base 0x07EF0000) (size 0x00000800) (align 0x00001000)
    (owner "01-header.wat:1826"))
  (region.declare-fixed $GDI_DC_SAVE_TABLE (base 0x07EF0800) (size 0x00000800) (align 0x00000100)
    (owner "01-header.wat:1829"))
  (region.declare-fixed $GDI_LINE_DESC (base 0x07EF1000) (size 0x00000050) (align 0x00001000)
    (owner "01-header.wat:1832"))
  (region.declare-fixed $GDI_BLIT_DESC (base 0x07EF1100) (size 0x000000A0) (align 0x00000100)
    (owner "01-header.wat:1836"))
  (region.declare-fixed $GDI_BITMAP_PLAN (base 0x07EF11A0) (size 0x00000030) (align 0x00000010)
    (owner "01-header.wat:1842"))
  (region.declare-fixed $GDI_BITMAP_NAME (base 0x07EF11D0) (size 0x00000100) (align 0x00000010)
    (owner "01-header.wat:1845"))
  (region.declare-fixed $WINDOW_RECT_SCRATCH (base 0x07EF12D0) (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:1850"))
  (region.declare-fixed $GDI_BRUSH_DESC (base 0x07EF12E0) (size 0x00000050) (align 0x00000010)
    (owner "01-header.wat:1854"))
  (region.declare-fixed $GDI_PALETTE_RESOLVE (base 0x07EF1330) (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:1858"))
  (region.declare-fixed $GDI_OBJECT_GEN (base 0x07EF1730) (size 0x00000004) (align 0x00000010)
    (owner "01-header.wat:1871"))
  (region.declare-fixed $GDI_WINDOW_SURFACE_HWM (base 0x07EF1734) (size 0x00000004)
    (owner "01-header.wat:1884"))
  (region.declare-fixed $GDI_DC_STATE_TABLE (base 0x07EF1800) (size 0x00006000) (align 0x00000100)
    (owner "01-header.wat:1862"))
  (region.declare-fixed $GDI_OBJECT_TABLE (base 0x07EF7800) (size 0x00003000) (align 0x00000100)
    (owner "01-header.wat:1873"))
  (region.declare-fixed $GDI_WINDOW_SURFACE_TABLE (base 0x07EFA800) (size 0x00002000) (align 0x00000100)
    (owner "01-header.wat:1886"))
  (region.declare-fixed $GDI_DC_AUX_TABLE (base 0x07EFC800) (size 0x00002000) (align 0x00000100)
    (owner "01-header.wat:1890"))
  (region.declare-fixed $GDI_COLOR_ADJUST_TABLE (base 0x07EFE800) (size 0x00001800) (align 0x00000100)
    (owner "01-header.wat:1894"))
  (region.declare-fixed $PROP_TABLE (base 0x07F00400) (size 0x00000C00) (align 0x00000100)
    (owner "01-header.wat:2063"))
  (region.declare-fixed $PAINT_FLAGS (base 0x07F01000) (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:2744"))
  (region.declare-fixed $TAB_NATIVE_STATE_TABLE (base 0x07F01200) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2200"))
  (region.declare-fixed $ICON_TABLE (base 0x07F01300) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2207"))
  (region.declare-fixed $CURSOR_TABLE (base 0x07F01400) (size 0x00000300) (align 0x00000100)
    (owner "01-header.wat:2217"))
  (region.declare-fixed $CURSOR_MASK_DESC (base 0x07F01700) (size 0x00000050) (align 0x00000100)
    (owner "01-header.wat:2224"))
  (region.declare-fixed $CURSOR_COLOR_DESC (base 0x07F01750) (size 0x00000050) (align 0x00000010)
    (owner "01-header.wat:2226"))
  (region.declare-fixed $EDIT_LAYOUT_SCRATCH (base 0x07F01800) (size 0x00000C00) (align 0x00000100)
    (owner "01-header.wat:1799"))
  (region.declare-fixed $VIRTUAL_MAP_STATE (base 0x07F02400) (size 0x00000010) (align 0x00000100)
    (owner "01-header.wat:2238"))
  (region.declare-fixed $VIRTUAL_MAP_TABLE (base 0x07F02410) (size 0x00008000) (align 0x00000010)
    (owner "01-header.wat:2240"))
  (region.declare-fixed $GDI_BITMAP_FONT_IO (base 0x07F0A420) (size 0x00000004) (align 0x00000010)
    (owner "10b-gdi-font.wat:11"))
  (region.declare-fixed $GDI_BITMAP_FONT_DESC (base 0x07F0A440) (size 0x00000050) (align 0x00000010)
    (owner "10b-gdi-font.wat:13"))
  (region.declare-fixed $GDI_BITMAP_FONT_STATIC (base 0x07F0A490) (size 0x00000170) (align 0x00000010)
    (owner "01-header.wat:1523"))
  (region.declare-fixed $GDI_BITMAP_FONT_LRU (base 0x07F0A600) (size 0x000000C0) (align 0x00000100)
    (owner "10b-gdi-font.wat:38"))
  (region.declare-fixed $GDI_BITMAP_FONT_TABLE (base 0x07F0A800) (size 0x00000C00) (align 0x00000100)
    (owner "10b-gdi-font.wat:7"))
  (region.declare-fixed $TT_SUBST_TABLE (base 0x07F0B400) (size 0x00000800) (align 0x00000100)
    (owner "10c-truetype.wat:3370"))
  (region.declare-fixed $TT_SUBST_ALIAS_TABLE (base 0x07F0BC00) (size 0x00000300) (align 0x00000100)
    (owner "10c-truetype.wat:3419"))
  (region.declare-fixed $TT_FONT_STRING_STORAGE (base 0x07F0BF00) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1525"))
  (region.declare-fixed $GDI_DC_SYSTEM_CLIP_TABLE (base 0x07F0C000) (size 0x00000800) (align 0x00001000)
    (owner "01-header.wat:1897"))
  (region.declare-fixed $HEAP_SHARED (base 0x07F0C800) (size 0x00000040) (align 0x00000100)
    (owner "01-header.wat:2257"))
  (region.declare-fixed $LOCK_TABLE (base 0x07F0C840) (size 0x00000200) (align 0x00000010)
    (owner "01-header.wat:2275"))
  (region.declare-fixed $CS_TABLE (base 0x07F0CA40) (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2284"))
  (region.declare-fixed $SHARED_COUNTERS (base 0x07F0CE40) (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:2307"))
  (region.declare-fixed $GDI_TABLE_MARKS (base 0x07F0CE60) (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:1908"))
  (region.declare-fixed $TV_SLOT_MARK (base 0x07F0CE80) (size 0x00000004) (align 0x00000010)
    (owner "01-header.wat:1920"))
  (region.declare-fixed $TV_HANDLE_SEQ (base 0x07F0CE84) (size 0x00000004)
    (owner "01-header.wat:1926"))
  (region.declare-fixed $DX_PROCESS_STATE (base 0x07F0CE90) (size 0x0000001C) (align 0x00000010)
    (owner "09a8-handlers-directx.wat:294"))
  (region.declare-fixed $LOOP_PROCESS_STATE (base 0x07F0CEE0) (size 0x00000004) (align 0x00000010)
    (owner "07b-loop-match.wat:76"))
  (region.declare-fixed $TV_VIEW_TABLE (base 0x07F0CF00) (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1930"))
  (region.declare-fixed $GDI_REGION_TABLE (base 0x07F0D000) (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:1807"))
  (region.declare-fixed $GDI_DC_PATH_TABLE (base 0x07F0F000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1811"))
  (region.declare-fixed $HANDLER_HIST_COUNTS (base 0x07F10000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1965"))
  (region.declare-fixed $CODE_PAGE_BITMAP (base 0x07F12000) (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:1983"))
  (region.declare-fixed $SYNC_TABLE (base 0x07F14000) (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:2232"))
  (region.declare-fixed $D3DIM_VIEWPORT_LIGHT_HEAD (base 0x07F16000) (size 0x00004000) (align 0x00001000)
    (owner "09aa-handlers-d3dim.wat:21"))
  (region.declare-fixed $HIT_COUNT_BASE (base 0x07F20000) (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:3212"))
  (region.declare-fixed $TIMER_SHARED (base 0x07F20100) (size 0x00000050) (align 0x00000100)
    (owner "01-header.wat:1743"))
  (region.declare-fixed $EXTRA_CMDLINE_BUFFER (base 0x07F20200) (size 0x00000100) (align 0x00000100)
    (owner "10-helpers.wat:1276"))
  (region.declare-fixed $TLS_NEXT_INDEX_SHARED (base 0x07F20300) (size 0x00000040) (align 0x00000100)
    (owner "01-header.wat:2636"))
  (region.declare-fixed $DI_MOUSE_INPUT_STATE (base 0x07F20400) (size 0x00000118) (align 0x00000100)
    (owner "09a8-handlers-directx.wat:367"))
  (region.declare-fixed $SCROLL_AUX_TABLE (base 0x07F21000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:2146"))
  (region.declare-fixed $TV_TABLE (base 0x07F22000) (size 0x00004000) (align 0x00001000)
    (owner "01-header.wat:2195"))
  (region.declare-fixed $TV_IMAGE_TABLE (base 0x07F26000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:2198"))
  (region.declare-fixed $TV_OWNER_TABLE (base 0x07F27000) (size 0x00000800) (align 0x00001000)
    (owner "01-header.wat:1912"))
  (region.declare-fixed $DX_SURF_META (base 0x07F28000) (size 0x00008000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:46"))
  (region.declare-fixed $OP_INDEX (base 0x07F30000) (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:1972"))
  (region.declare-fixed $DX_SURF_PAL (base 0x07F32000) (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:33"))
  (region.declare-fixed $DX_SURF_STATE (base 0x07F36000) (size 0x00020000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:65"))
  (region.declare-fixed $DX_CURSOR_SAVE (base 0x07F56000) (size 0x00008000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:72"))
  (region.declare-fixed $DX_OBJECTS (base 0x07F60000) (size 0x00020000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:16"))
  (region.declare-fixed $COM_WRAPPERS (base 0x07F80000) (size 0x00008000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:75"))
  (region.declare-fixed $DX_SURF_FMT (base 0x07F88000) (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:40"))
  (region.declare-fixed $DX_SURF_OWNER (base 0x07F8C000) (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:51"))
  (region.declare-fixed $CP1252_TO_CP437 (base 0x07F90000) (size 0x00000100) (align 0x00001000)
    (owner "09a-handlers.wat:15379"))
  (region.declare-fixed $CP437_TO_CP1252 (base 0x07F90100) (size 0x00000100) (align 0x00000100)
    (owner "09a-handlers.wat:15380"))
  (region.declare-fixed $BRANCH_CMP_JCC_HIST (base 0x07F91000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1989"))
  (region.declare-fixed $BRANCH_TEST_JCC_HIST (base 0x07F92000) (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1991"))
  (region.declare-fixed $BRANCH_ALU_M32_RO_JCC_HIST (base 0x07F93000) (size 0x00008000) (align 0x00001000)
    (owner "01-header.wat:1993"))
  (region.declare-fixed $HOT_BLOCK_HIST (base 0x07F9B000) (size 0x00040000) (align 0x00001000)
    (owner "01-header.wat:1995"))
  (region.declare-fixed $SIB_CONSUMER_HIST (base 0x07FDB000) (size 0x00010000) (align 0x00001000)
    (owner "01-header.wat:1999"))
  (region.declare-fixed $D3DIM_AUX (base 0x07FEB000) (size 0x00001000) (align 0x00001000)
    (owner "09ab-handlers-d3dim-core.wat:114"))
  (region.declare-fixed $D3DIM_MATRICES (base 0x07FEC000) (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:23"))
  (region.declare-fixed $COM_WRAPPERS_AUX (base 0x07FFA000) (size 0x00003EFC) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:81"))
  (region.declare-fixed $DX_VTBL_REGISTRY (base 0x07FFDEFC) (size 0x00000104)
    (owner "09a8-handlers-directx.wat:101"))
  (region.declare-fixed $VSOCK_TABLE (base 0x07FFE000) (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:2151"))
  (region.declare-fixed $VIRTUAL_BACKING_BASE (base 0x08000000) (size 0x14000000) (align 0x00001000)
    (owner "01-header.wat:2243"))
  (region.declare-fixed $DIB_BACKING_BASE (base 0x1C000000) (size 0x03F00000) (align 0x00001000)
    (owner "01-header.wat:2344"))
  (region.declare-fixed $THREAD_RPC (base 0x1FF00000) (size 0x00100000) (align 0x00001000)
    (owner "01-header.wat:2350"))

  ;; ============================================================
  ;; SPANS — address-range LIMITS, not storage.
  ;;
  ;; A span names a boundary somebody's arithmetic tests against. It owns no
  ;; bytes, so it is TRANSPARENT to the overlap check: the regions it bounds
  ;; live inside it, which is the whole point and the one thing no other head
  ;; can express. It is never allocated and never shaken, and it has no
  ;; $NAME/$NAME_SIZE globals behind it — there is nothing to store — so
  ;; tools/check-region-decls.js neither requires nor reads one.
  ;; ============================================================

  ;; $g2w's direct guest window (docs/watx-region-safety-design.md §5.1). A
  ;; guest address translates by the flat `ga - image_base + GUEST_BASE` rule
  ;; only while the result lands below this limit; past it $g2w falls through to
  ;; the DIB window, then the sparse VirtualAlloc map, then NULL_SENTINEL. The
  ;; window is a UNION of regions — $GUEST_BASE, the guest heap, the stack, the
  ;; thunk zone, PE staging, the DLL tables and the whole WAT-private high map —
  ;; so it cannot be declared with any head that participates in the overlap
  ;; sweep. Its end is $VIRTUAL_BACKING_BASE's base: everything at or above
  ;; 0x08000000 is backing store reached through a translation, never directly.
  ;; Written as the bare literal 0x8000000 three times in 03-registers.wat until
  ;; this declaration; those three sites now spell it (region.end $DIRECT_WINDOW).
  (region.declare-span $DIRECT_WINDOW (base 0x00000000) (end 0x08000000)
    (owner "03-registers.wat:81,177,179 — $g2w / $g2w_affine_span direct-window limit"))
