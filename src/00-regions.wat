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
  ;; The allocator starts here. Below it: NULL_SENTINEL at 0xF0, which
  ;; $g2w's sink behaviour pins and nothing may be placed on top of.
  (region.floor 0x00000100)

  (region.declare $STRING_CONSTANTS (size 0x00000280) (align 0x00000100)
    (owner "01-header.wat:882"))
  (region.declare $VK_SCAN_TABLES (size 0x00000080) (align 0x00000080)
    (owner "09a7-handlers-dispatch.wat:1944"))
  (region.declare $UPDATE_RECT (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1647"))
  (region.declare $UPDATE_FLAGS (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:1649"))
  ;; WIDENED 0x80 -> 0x1A0 (wave 2). The declaration covered only as far as
  ;; "SysLink"; the class-name block runs to the RGB555 masks at 0x32A0, so
  ;; everything past 0x3180 -- the DirectAnimation names, SysTreeView32, the
  ;; statusbar/toolbar classes -- sat outside every region and outside every
  ;; gate. The three blocks that follow used to be undeclared data segments.
  (region.declare $CLASS_NAME_STRINGS (size 0x000001A0) (align 0x00000100)
    (owner "01-header.wat:1658"))
  (region.declare $DIB_DEFAULT_RGB555_MASKS (size 0x0000000C) (align 0x00000010)
    (owner "01-header.wat:1214"))
  (region.declare $OLE_STRINGS (size 0x000000E0) (align 0x00000010)
    (owner "01-header.wat:1222"))
  (region.declare $ENV_DEFAULTS (size 0x000000C0) (align 0x00000010)
    (owner "01-header.wat:1252"))
  (region.declare $WND_BG_BRUSH_TABLE (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1635"))
  (region.declare $WND_CLASS_CURSOR_TABLE (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1643"))
  (region.declare $CLASS_EXTRA_TABLE (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1793"))
  ;; The two Win16 name tables in the hole after CLASS_EXTRA_TABLE. Both were
  ;; raw (data (i32.const ...)) segments in no region at all; each is sized to
  ;; exactly the bytes its segment emits, so growing one is a compile error.
  (region.declare $WIN16_FONT_FACES (size 0x00000030) (align 0x00000100)
    (owner "09e-win16-api.wat:9232"))
  (region.declare $WIN16_MMSYSTEM_NAMES (size 0x0000005D) (align 0x00000010)
    (owner "09e-win16-api.wat:10008"))
  (region.declare $DIALOG_STATE_TABLE (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:2113"))
  (region.declare $WINDOW_UNICODE_TABLE (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:2115"))
  (region.declare $SHARED_PROCESS_ID (size 0x00000004) (align 0x00000100)
    (owner "01-header.wat:2119"))
  (region.declare $SHARED_DLG_ENDED (size 0x00000004)
    (owner "01-header.wat:2961"))
  (region.declare $SHARED_DLG_RESULT (size 0x00000004)
    (owner "01-header.wat:2963"))
  (region.declare $SHARED_DLG_PUMP_HWND (size 0x00000004)
    (owner "01-header.wat:2972"))
  ;; Host-supplied environment overrides. The 240-byte extent is the bound
  ;; $test_launch_env_add already enforced as a bare literal; it now reads the
  ;; region's own size, so the two cannot disagree.
  (region.declare $LAUNCH_ENV_OVERRIDES (size 0x000000F0) (align 0x00000010)
    (owner "01-header.wat:2991"))
  (region.declare $WINDOW_EXTRA_TABLE (size 0x00001000) (align 0x00000100)
    (owner "01-header.wat:2124"))
  (region.declare $PAINT_SCRATCH (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2049"))
  (region.declare $WND_CLASS_SLOT_TABLE (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1788"))
  (region.declare $WND_RECORDS (size 0x00001800) (align 0x00001000)
    (owner "01-header.wat:1630"))
  (region.declare $CONTROL_TABLE (size 0x00001000) (align 0x00000100)
    (owner "01-header.wat:2010"))
  (region.declare $CONTROL_GEOM (size 0x00000800) (align 0x00000100)
    (owner "01-header.wat:2017"))
  (region.declare $CLASS_RECORDS (size 0x00000C00) (align 0x00001000)
    (owner "01-header.wat:2034"))
  (region.declare $TIMER_TABLE (size 0x00000140) (align 0x00000100)
    (owner "01-header.wat:2752"))
  (region.declare $MENU_DATA_TABLE (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2088"))
  (region.declare $WND_DLG_RECORDS (size 0x00002000) (align 0x00000010)
    (owner "01-header.wat:2105"))
  ;; Four dwords of cross-instance waveOut identity in the 16-byte hole
  ;; between WND_DLG_RECORDS and SCROLL_TABLE. Declared rather than spelled
  ;; (region.end $WND_DLG_RECORDS): it is its own object, and an adjacency is
  ;; not an address (docs/watx-region-safety-design.md 5.1).
  (region.declare $WAVE_OUT_SHARED (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:2578"))
  (region.declare $SCROLL_TABLE (size 0x00001800) (align 0x00000010)
    (owner "01-header.wat:2138"))
  (region.declare $FLASH_TABLE (size 0x00000100) (align 0x00000010)
    (owner "01-header.wat:2156"))
  (region.declare $NC_FLAGS (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:1653"))
  (region.declare $TITLE_TABLE (size 0x00000800) (align 0x00000010)
    (owner "01-header.wat:1679"))
  (region.declare $CLIENT_RECT (size 0x00001000) (align 0x00000010)
    (owner "01-header.wat:2006"))
  (region.declare $SHOW_STATE_TABLE (size 0x00000100) (align 0x00000010)
    (owner "01-header.wat:2167"))
  (region.declare $WINDOW_REGION_BITS (size 0x00000020) (align 0x00000010)
    (owner "01-header.wat:2173"))
  (region.declare $NATIVE_STATUS_BITS (size 0x00000020) (align 0x00000010)
    (owner "01-header.wat:2023"))
  (region.declare $NATIVE_TAB_BITS (size 0x00000020) (align 0x00000010)
    (owner "01-header.wat:2027"))
  (region.declare $SHARED_MODAL_DLG_HWND (size 0x00000004) (align 0x00000010)
    (owner "01-header.wat:2979"))
  (region.declare $SHARED_MODAL_RESULT (size 0x00000004)
    (owner "01-header.wat:2981"))
  (region.declare $SHARED_MODAL_DONE (size 0x00000004)
    (owner "01-header.wat:2983"))
  (region.declare $CS_RING (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2401"))
  (region.declare $MCI_DEVICE_TABLE (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1686"))
  (region.declare $OWNER_TABLE (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1691"))
  ;; The reserved page just below GUEST_BASE. Four undeclared string blocks
  ;; interleaved with the declared tables that already lived here; each is
  ;; bounded by the next declared region, so the extents are not guesses.
  (region.declare $USER_DIALOG_STRINGS (size 0x00000270) (align 0x00001000)
    (owner "01-header.wat:1133"))
  (region.declare $DX_VERSION_INFO (size 0x0000005C) (align 0x00000010)
    (owner "01-header.wat:3457"))
  (region.declare $ORDINAL_NAMES_WSOCK32 (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:968"))
  (region.declare $DI_DIK_VK_TABLE (size 0x00000100) (align 0x00000100)
    (owner "09a8-handlers-directx.wat:6309"))
  (region.declare $ORDINAL_NAMES_OLEAUT32 (size 0x00000080) (align 0x00000100)
    (owner "01-header.wat:988"))
  (region.declare $RICHEDIT_FORMAT_TABLE (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2178"))
  (region.declare $RICHEDIT_PARA_TABLE (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2182"))
  (region.declare $RESERVED_PAGE_STRINGS (size 0x00000280) (align 0x00000080)
    (owner "01-header.wat:1002"))
  (region.declare-fixed $GUEST_BASE (base 0x00012000) (size 0x03C00000) (align 0x00001000)
    (owner "01-header.wat:1449"))
  ;; WIDENED 0x100000 -> 0x3EE000 (wave 3). The low heap never fitted in 1MB:
  ;; $heap_low_reserve hands out 1MB chunks and stopped only when the next
  ;; chunk would reach $PAGE_INDEX_ARENA, which the hand-placed map happened to
  ;; put 4MB further up. The room a table grows into belongs in its own (size),
  ;; where a bound is checked, not in an anonymous hole beside it — reclaiming
  ;; that hole moved the page indexes down to 0x03E12000 and left the heap with
  ;; one chunk, which is a broken emulator, not a broken declaration.
  (region.declare-derived $GUEST_HEAP_BASE (base (g2w 0x04100000)) (size 0x003EE000) (align 0x00001000)
    (owner "01-header.wat:1453"))
  (region.declare $HANDLER_PAIR_HIST_COUNTS (size 0x00100000) (align 0x00001000)
    (owner "01-header.wat:1986"))
  (region.declare $PAGE_INDEX_ARENA (size 0x00800000) (align 0x00001000)
    (owner "01-header.wat:1483"))
  (region.declare $PAGE_DIR_BASE (size 0x00020000) (align 0x00001000)
    (owner "01-header.wat:1496"))
  (region.declare $WIN16_APP_DLL_STAGING (size 0x00600000) (align 0x00001000)
    (owner "01-header.wat:3356"))
  (region.declare $THREAD_CACHE_BASE (size 0x02000000) (align 0x00001000)
    (owner "01-header.wat:1458"))
  (region.declare-derived $GUEST_STACK (base (g2w 0x07400000)) (size 0x00100000) (align 0x00001000)
    (owner "01-header.wat:1451"))
  (region.declare-derived $THUNK_BASE (base (g2w 0x07500000)) (size 0x00040000) (align 0x00001000)
    (owner "01-header.wat:1455"))
  (region.declare $PE_STAGING (size 0x00800000) (align 0x00001000)
    (owner "01-header.wat:1447"))
  (region.declare $DLL_TABLE (size 0x00000200) (align 0x00001000)
    (owner "01-header.wat:2618"))
  (region.declare $DLL_RSRC_TABLE (size 0x00000080) (align 0x00000100)
    (owner "01-header.wat:2620"))
  (region.declare $DLL_PATH_TABLE (size 0x00000040) (align 0x00000100)
    (owner "01-header.wat:2623"))
  (region.declare $GDI_BITMAP_TEXT_LAYOUT (size 0x00021000) (align 0x00001000)
    (owner "10b-gdi-font.wat:1971"))
  (region.declare $GDI_BITMAP_TEXT_PREFIX (size 0x00011000) (align 0x00001000)
    (owner "10b-gdi-font.wat:1974"))
  (region.declare $WND_Z_ORDER_TABLE (size 0x00000400) (align 0x00001000)
    (owner "01-header.wat:1756"))
  (region.declare $WND_CLASS_ICON_TABLE (size 0x00000400) (align 0x00001000)
    (owner "01-header.wat:1704"))
  (region.declare $WIN16_FILE_TABLE (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1767"))
  (region.declare $WND_OWN_DC_TABLE (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1716"))
  (region.declare $WND_HINSTANCE_TABLE (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1751"))
  (region.declare $WIN16_BUILTIN_NAMES (size 0x00000200) (align 0x00001000)
    (owner "09e-win16-api.wat:10005"))
  (region.declare $WND_THREAD_TABLE (size 0x00000400) (align 0x00000100)
    (owner "01-header.wat:1726"))
  (region.declare $THREAD_MSG_QUEUES (size 0x00002080) (align 0x00000100)
    (owner "01-header.wat:1737"))
  (region.declare $GDI_NEAREST_CACHE (size 0x00008000) (align 0x00001000)
    (owner "10g-gdi-raster.wat:3820"))
  (region.declare $WIN16_THUNK_TABLE (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:3242"))
  (region.declare $WIN16_SEG_TABLE (size 0x00004000) (align 0x00001000)
    (owner "01-header.wat:3233"))
  (region.declare $API_HASH_TABLE (size 0x00008000) (align 0x00001000)
    (owner "01-header.wat:1615"))
  (region.declare $TEXT_SCRATCH (size 0x00000400) (align 0x00001000)
    (owner "01-header.wat:3173"))
  (region.declare $CONSOLE_TEXT (size 0x00003000) (align 0x00001000)
    (owner "01-header.wat:3179"))
  (region.declare $CONSOLE_ATTR (size 0x00003000) (align 0x00001000)
    (owner "01-header.wat:3181"))
  (region.declare $CONSOLE_INPUT (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:3198"))
  (region.declare $DIB_PAGE_USED (size 0x00004000) (align 0x00001000)
    (owner "01-header.wat:2352"))
  (region.declare $DIB_PAGE_RUNS (size 0x00008000) (align 0x00001000)
    (owner "01-header.wat:2354"))
  (region.declare $GDI_REGION_BANDS (size 0x000D0000) (align 0x00001000)
    (owner "01-header.wat:1818"))
  (region.declare $GDI_REGION_WORK (size 0x00003400) (align 0x00001000)
    (owner "01-header.wat:1820"))
  (region.declare $GDI_DC_CLIP_TABLE (size 0x00000800) (align 0x00001000)
    (owner "01-header.wat:1826"))
  (region.declare $GDI_DC_SAVE_TABLE (size 0x00000800) (align 0x00000100)
    (owner "01-header.wat:1829"))
  (region.declare $GDI_LINE_DESC (size 0x00000050) (align 0x00001000)
    (owner "01-header.wat:1832"))
  (region.declare $GDI_BLIT_DESC (size 0x000000A0) (align 0x00000100)
    (owner "01-header.wat:1836"))
  (region.declare $GDI_BITMAP_PLAN (size 0x00000030) (align 0x00000010)
    (owner "01-header.wat:1842"))
  (region.declare $GDI_BITMAP_NAME (size 0x00000100) (align 0x00000010)
    (owner "01-header.wat:1845"))
  (region.declare $WINDOW_RECT_SCRATCH (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:1850"))
  (region.declare $GDI_BRUSH_DESC (size 0x00000050) (align 0x00000010)
    (owner "01-header.wat:1854"))
  (region.declare $GDI_PALETTE_RESOLVE (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:1858"))
  (region.declare $GDI_OBJECT_GEN (size 0x00000004) (align 0x00000010)
    (owner "01-header.wat:1871"))
  (region.declare $GDI_WINDOW_SURFACE_HWM (size 0x00000004)
    (owner "01-header.wat:1884"))
  (region.declare $GDI_DC_STATE_TABLE (size 0x00006000) (align 0x00000100)
    (owner "01-header.wat:1862"))
  (region.declare $GDI_OBJECT_TABLE (size 0x00003000) (align 0x00000100)
    (owner "01-header.wat:1873"))
  (region.declare $GDI_WINDOW_SURFACE_TABLE (size 0x00002000) (align 0x00000100)
    (owner "01-header.wat:1886"))
  (region.declare $GDI_DC_AUX_TABLE (size 0x00002000) (align 0x00000100)
    (owner "01-header.wat:1890"))
  (region.declare $GDI_COLOR_ADJUST_TABLE (size 0x00001800) (align 0x00000100)
    (owner "01-header.wat:1894"))
  (region.declare $PROP_TABLE (size 0x00000C00) (align 0x00000100)
    (owner "01-header.wat:2063"))
  (region.declare $PAINT_FLAGS (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:2744"))
  (region.declare $TAB_NATIVE_STATE_TABLE (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2200"))
  (region.declare $ICON_TABLE (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:2207"))
  (region.declare $CURSOR_TABLE (size 0x00000300) (align 0x00000100)
    (owner "01-header.wat:2217"))
  (region.declare $CURSOR_MASK_DESC (size 0x00000050) (align 0x00000100)
    (owner "01-header.wat:2224"))
  (region.declare $CURSOR_COLOR_DESC (size 0x00000050) (align 0x00000010)
    (owner "01-header.wat:2226"))
  (region.declare $EDIT_LAYOUT_SCRATCH (size 0x00000C00) (align 0x00000100)
    (owner "01-header.wat:1799"))
  (region.declare $VIRTUAL_MAP_STATE (size 0x00000010) (align 0x00000100)
    (owner "01-header.wat:2238"))
  (region.declare $VIRTUAL_MAP_TABLE (size 0x00008000) (align 0x00000010)
    (owner "01-header.wat:2240"))
  (region.declare $GDI_BITMAP_FONT_IO (size 0x00000004) (align 0x00000010)
    (owner "10b-gdi-font.wat:11"))
  (region.declare $GDI_BITMAP_FONT_DESC (size 0x00000050) (align 0x00000010)
    (owner "10b-gdi-font.wat:13"))
  (region.declare $GDI_BITMAP_FONT_STATIC (size 0x00000170) (align 0x00000010)
    (owner "01-header.wat:1523"))
  (region.declare $GDI_BITMAP_FONT_LRU (size 0x000000C0) (align 0x00000100)
    (owner "10b-gdi-font.wat:38"))
  (region.declare $GDI_BITMAP_FONT_TABLE (size 0x00000C00) (align 0x00000100)
    (owner "10b-gdi-font.wat:7"))
  (region.declare $TT_SUBST_TABLE (size 0x00000800) (align 0x00000100)
    (owner "10c-truetype.wat:3370"))
  (region.declare $TT_SUBST_ALIAS_TABLE (size 0x00000300) (align 0x00000100)
    (owner "10c-truetype.wat:3419"))
  (region.declare $TT_FONT_STRING_STORAGE (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1525"))
  (region.declare $GDI_DC_SYSTEM_CLIP_TABLE (size 0x00000800) (align 0x00001000)
    (owner "01-header.wat:1897"))
  (region.declare $HEAP_SHARED (size 0x00000040) (align 0x00000100)
    (owner "01-header.wat:2257"))
  (region.declare $LOCK_TABLE (size 0x00000200) (align 0x00000010)
    (owner "01-header.wat:2275"))
  (region.declare $CS_TABLE (size 0x00000400) (align 0x00000010)
    (owner "01-header.wat:2284"))
  (region.declare $SHARED_COUNTERS (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:2307"))
  (region.declare $GDI_TABLE_MARKS (size 0x00000010) (align 0x00000010)
    (owner "01-header.wat:1908"))
  (region.declare $TV_SLOT_MARK (size 0x00000004) (align 0x00000010)
    (owner "01-header.wat:1920"))
  (region.declare $TV_HANDLE_SEQ (size 0x00000004)
    (owner "01-header.wat:1926"))
  (region.declare $DX_PROCESS_STATE (size 0x0000001C) (align 0x00000010)
    (owner "09a8-handlers-directx.wat:294"))
  (region.declare $LOOP_PROCESS_STATE (size 0x00000004) (align 0x00000010)
    (owner "07b-loop-match.wat:76"))
  (region.declare $TV_VIEW_TABLE (size 0x00000100) (align 0x00000100)
    (owner "01-header.wat:1930"))
  (region.declare $GDI_REGION_TABLE (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:1807"))
  (region.declare $GDI_DC_PATH_TABLE (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1811"))
  (region.declare $HANDLER_HIST_COUNTS (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1965"))
  (region.declare $CODE_PAGE_BITMAP (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:1983"))
  (region.declare $SYNC_TABLE (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:2232"))
  (region.declare $D3DIM_VIEWPORT_LIGHT_HEAD (size 0x00004000) (align 0x00001000)
    (owner "09aa-handlers-d3dim.wat:21"))
  (region.declare $HIT_COUNT_BASE (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:3212"))
  (region.declare $TIMER_SHARED (size 0x00000050) (align 0x00000100)
    (owner "01-header.wat:1743"))
  (region.declare $EXTRA_CMDLINE_BUFFER (size 0x00000100) (align 0x00000100)
    (owner "10-helpers.wat:1276"))
  (region.declare $TLS_NEXT_INDEX_SHARED (size 0x00000040) (align 0x00000100)
    (owner "01-header.wat:2636"))
  (region.declare $DI_MOUSE_INPUT_STATE (size 0x00000118) (align 0x00000100)
    (owner "09a8-handlers-directx.wat:367"))
  (region.declare $SCROLL_AUX_TABLE (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:2146"))
  (region.declare $TV_TABLE (size 0x00004000) (align 0x00001000)
    (owner "01-header.wat:2195"))
  (region.declare $TV_IMAGE_TABLE (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:2198"))
  (region.declare $TV_OWNER_TABLE (size 0x00000800) (align 0x00001000)
    (owner "01-header.wat:1912"))
  (region.declare $DX_SURF_META (size 0x00008000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:46"))
  (region.declare $OP_INDEX (size 0x00002000) (align 0x00001000)
    (owner "01-header.wat:1972"))
  (region.declare $DX_SURF_PAL (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:33"))
  (region.declare $DX_SURF_STATE (size 0x00020000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:65"))
  (region.declare $DX_CURSOR_SAVE (size 0x00008000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:72"))
  ;; Harness-only. The worker-thread tests rendezvous here and the GDI region
  ;; tests marshal a RECT and a POINT array through it; no WAT reads any of it.
  ;; Declared for the reason everything else here is: every one of these cells
  ;; used to be a raw address picked out of a hole, or out of somebody else's
  ;; table, and both are free only until something moves.
  (region.declare $TEST_SCRATCH (size 0x00000100) (align 0x00001000)
    (owner "01-header.wat:2373"))
  (region.declare $DX_OBJECTS (size 0x00020000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:16"))
  (region.declare $COM_WRAPPERS (size 0x00008000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:75"))
  (region.declare $DX_SURF_FMT (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:40"))
  (region.declare $DX_SURF_OWNER (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:51"))
  (region.declare $CP1252_TO_CP437 (size 0x00000100) (align 0x00001000)
    (owner "09a-handlers.wat:15379"))
  (region.declare $CP437_TO_CP1252 (size 0x00000100) (align 0x00000100)
    (owner "09a-handlers.wat:15380"))
  (region.declare $BRANCH_CMP_JCC_HIST (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1989"))
  (region.declare $BRANCH_TEST_JCC_HIST (size 0x00001000) (align 0x00001000)
    (owner "01-header.wat:1991"))
  (region.declare $BRANCH_ALU_M32_RO_JCC_HIST (size 0x00008000) (align 0x00001000)
    (owner "01-header.wat:1993"))
  (region.declare $HOT_BLOCK_HIST (size 0x00040000) (align 0x00001000)
    (owner "01-header.wat:1995"))
  (region.declare $SIB_CONSUMER_HIST (size 0x00010000) (align 0x00001000)
    (owner "01-header.wat:1999"))
  (region.declare $D3DIM_AUX (size 0x00001000) (align 0x00001000)
    (owner "09ab-handlers-d3dim-core.wat:114"))
  (region.declare $D3DIM_MATRICES (size 0x00004000) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:23"))
  (region.declare $COM_WRAPPERS_AUX (size 0x00003EFC) (align 0x00001000)
    (owner "09a8-handlers-directx.wat:81"))
  (region.declare $DX_VTBL_REGISTRY (size 0x00000104)
    (owner "09a8-handlers-directx.wat:101"))
  (region.declare $VSOCK_TABLE (size 0x00002000) (align 0x00001000)
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
