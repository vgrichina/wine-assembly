# Wine-Assembly — Architecture & Performance Review

*2026-08-18. Reviewed at commit `ab4aae3` ("Finish DDEML: wildconnect, busy, real timeouts, and an error code fix"). Four parallel deep reviews: CPU/emulator core, Win32/controls WAT layer, JS host layer, tools/build system — plus focused deep-dives into the three largest files (`10-helpers.wat`, `09a7-handlers-dispatch.wat`, `09c3-controls.wat`) and the state-table layer. All claims carry file:line evidence; line numbers are as of the reviewed commit.*

---

## Verdict

The macro-architecture is sound. The threaded-code interpreter, the generated br_table dispatch, the append-only API table, the yield mechanism, and the "logic in WAT, JS only rasterizes" principle all hold up under scrutiny, and several subsystems are in genuinely good shape (string ops, WND_RECORDS encapsulation, the build gates that do exist, the tool families that share code).

The problems are almost all **drift**, in three forms:

1. **File organization has drifted from file names.** The three biggest files are mislabeled: a 17k-line "helpers" file that is 74% a complete GDI implementation, a 12.6k-line "dispatch" file that is 81% OLE/COM, and the core window table living in a file named "help".
2. **Parallel hand-copies have diverged into real bugs.** A/W API pairs, the browser-vs-CLI host paths, control paint code, and ~24 PE parsers in tools/ are maintained by copy — and the copies measurably disagree (five confirmed behavioral divergences listed below).
3. **Invariants are kept in sync by discipline, not by the build.** The WAT_FILES manifest, the generated dispatch/hash tables, api_table.json ids, ordinal string offsets, and the slot-parallel window tables all have "keep in sync" contracts with no checker — and one (WAT_FILES) has already bitten once.

On performance, there are a small number of concrete, high-leverage issues: a per-block pattern-scan tax and a per-block debug gauntlet in the interpreter's hottest loop, generic re-dispatch of decode-time constants in memory-form ALU ops, a 4ms timer clamp capping the browser drive loop, an unconditional full-desktop composite per step, and per-call garbage in hot import wrappers.

---

## Part 1 — File organization: the names lie

The build is a pure concatenation of `src/*.wat` in filename order, so every fix in this section is a zero-risk mechanical file move/rename (plus the `WAT_FILES` update in `lib/compile-wat.js`).

### 1.1 `10-helpers.wat` (17,156 lines) is a mislabeled GDI subsystem

Of its 538 functions, **336 are `$gdi_*` (~12,700 lines, 74%)**, forming a complete GDI implementation:

- Region allocator + polygon scan-converter — `src/10-helpers.wat:451-1060`
- Full path engine incl. flatten/widen/stroke — `10-helpers.wat:1288-3290`
- Palettes — `10-helpers.wat:3648-3850`
- WMF/EMF metafile recorder+player — `$gdi_metafile_play_wmf` alone is ~594 lines (`10-helpers.wat:4570-5164`), `_emf` ~562 lines (`5552-6114`)
- DC state/save/restore — `10-helpers.wat:6250-6720`
- Software rasterizer with clip bands and brush sampling — `10-helpers.wat:8000-10800`

The tail (`14564-16218`) is richedit/clipboard/WordPad/menu-command logic — app/UI-level code (`$wordpad_colorref_for_index:15437`, `$wordpad_richedit_paste_clipboard:16032`, `$menu_try_edit_command:16164`, `$menu_try_wordpad_color_command:16134`) that belongs with the 09a4/09a5 handler files, plus message-layer code (`$wnd_child_from_point_deep:15235`). Only ~1,000 lines (strings/heap/DIB alloc at top, resource walker `13414-13610`, guest string helpers `13680-14015`) match the documented purpose "String/memory helpers, heap allocator, resource walker" (CLAUDE.md).

**Cost:** the project's most substantial single subsystem — the software GDI rasterizer — is invisible behind the least informative filename. **Fix:** split into `10d-gdi-region.wat`, `10e-gdi-path.wat`, `10f-gdi-metafile.wat`, `10g-gdi-raster.wat`, etc.; move the wordpad/menu tail next to the richedit/menu code.

### 1.2 `09a7-handlers-dispatch.wat` (12,631 lines) is 81% OLE/COM

All 622 functions categorized:

- **OLE/COM: 489 funcs, 10,190 lines (81%)**, contiguous at `09a7:669-10567`. Sub-blocks: ROT/Moniker/BindCtx 669–2580; IFont 2583–2979; storage/stream/CFB 2980–5559 (the CFB serializer alone is 4116–4862); IDataObject/clipboard 5560–7650; IOleObject/IOleCache/IViewObject 7650–10061; misc OLE 10062–10567.
- Misc late handlers: 93 funcs, 1,729 lines. mixer/winmm: 18 funcs (`12157-12571`). Atoms: 18 funcs (`11421-11634`).
- **Actual sub-dispatchers — the file's namesake: 4 funcs, 111 lines** (`09a7:8, :29, :55, :127`). The header comment at `09a7:2` describes <1% of the file.

**Fix:** carve the OLE/COM block into its own `09a7b-ole.wat` (or several); move mixer handlers next to audio (09a3), atoms next to their kin.

### 1.3 `09c-help.wat` — the core window table lives in a file named "help"

Lines 21–774 (50 of 77 functions) are core windowing: the window table and `$wnd_record_addr` (`09c-help.wat:21`), parallel-table resets, GWL/cbWndExtra, dialog-state table, sibling walk, style accessors, the class table (`:672,701,716`), `$wat_wndproc_dispatch:727`, and `$set_focus:763`. Help proper only starts at `:775`. The single most central windowing data structure in the project is filed under "help", and CLAUDE.md's file table already has to explain the mismatch. **Fix:** split into `09c0-window-table.wat` + help remainder.

### 1.4 `09a-handlers.wat` (13,905 lines) is a residual bucket

893 handlers with every topical bucket spanning the whole file; median handler is 9 lines and ordering is chronological-by-need:

- **GDI: 132 handlers here vs 109 in the dedicated `09a4-handlers-gdi.wat`** — the "misc" file holds more GDI surface than the GDI file. Contiguous slabs at `09a:9458-10152`, `6215-6560`, `7536-7885`.
- **comctl32: a 720-line slab** (ImageList/toolbar/statusbar/DSA/DPA) at `09a:12552-13270`, while `09c3-controls.wat` has zero `$handle_*` entry points.
- **Menu: 38 handlers scattered** (`09a:1813, 2804, 2971-3021, 10579-10623, 11438-11548, 11842-11970`) while `09c5-menu.wat` has 75 `menu_*` helpers and zero entry points.
- Conversely, `09a4-handlers-gdi.wat:681` holds `$handle_SetMenu` — a USER API.

**Fix:** relocate the three contiguous slabs first (GDI→09a4, comctl32→09c3 or a new file, menu→09c5) — that alone moves ~2k lines to where a reader would look for them.

### 1.5 `01-header.wat` — 249 functions pretending to be imports

The file contains 181 genuine `(import "host" ...)` declarations and **249 `(func $host_gdi_* ...)` definitions** that are no longer imports — WAT reimplementations (calling the 10-helpers GDI code) that kept their import-era `$host_` names and their spot in the "module declaration, host imports" file (`01-header.wat:142+`). Both the name and the location actively lie: a reader tracing `$host_gdi_fill_rect` assumes a JS boundary crossing that doesn't exist. **Fix:** rename to `$gdi_*` shims, move next to the GDI code as part of the 1.1 split; keep 01-header to real imports, memory layout, globals.

### 1.6 `06-fpu.wat` carries non-FPU core handlers

The nominal x87 file carries the entire 16-bit ALU/MOV handler family (`$th_alu_r16_m16:968`, `$th_mov_m16_i16:1040`) plus core non-FPU handlers (`$th_call_r:1051`, `$th_jmp_r:1067`, `$th_lea_sib:1130`, `$th_compute_ea_sib:1149`, all the `*_ro` ALU forms `1175+`) that duplicate 05-alu patterns at another width. **Fix:** file-move into 05-alu at minimum.

---

## Part 2 — Copy-paste with measured divergence

This is the dangerous kind of duplication: not verbose-but-identical, but parallel copies that have already drifted apart. Five confirmed behavioral divergences are marked **[BUG]**.

### 2.1 WAT layer

**The W message pump is a diverged parallel copy of the A pump, in a different file.**
`GetMessageA` (`src/09a5-handlers-window.wat:1396`, ~235 lines) vs `GetMessageW` (`src/09a-handlers.wat:11194`, ~188 lines); `DispatchMessage` `09a5:1892` vs `09a:10870` (similarity ~0.64); `PeekMessage` `09a5:1630` vs `09a:10996`; `DefWindowProc` `09a5:2127` vs `09a:4992`. GetMessageW reimplements the 11-phase delivery pipeline documented in CLAUDE.md rather than delegating, and **[BUG-adjacent]** is already missing phases the A side has (8 vs 6 matches on timer/paint/startup markers). The comment at `09a:10916` literally says "Keep this in sync with DispatchMessageA". Any message-ordering fix must currently be applied 2–3 times across two files.
*Fix:* extract `$getmessage_core(msg_ptr, wide)`; make the W handlers 10-line wrappers converting WM_CHAR/text payloads.

**A/W handler pairs: 44 of 184 split across files; 47 fully independent reimplementations.**
Split pairs edited independently include CreateWindowEx (09a5 / `09a:4903`), MessageBox, CreateFont (`09a4:598` / 09a), TextOut, RegOpenKeyEx, CreateDialogParam (09a5 / `09a7:12572`). Of the within-file pairs, ~60 are byte-identical bodies differing only in a wide flag (e.g. `handle_CreateFileA` `09a:759` vs `W` `09a:7378`); 47 are independent reimplementations, including:
- **[BUG]** `SystemParametersInfoW` at `09a:6733` is a 6-line stub shadowing an 84-line A implementation at `09a:6739`.
- `RegisterClass{,Ex}{A,W}` is a 4-way ~30-line copy (`09a:4347/4308/4932/4960`).
- `GetModuleFileNameA` `09a:1473` vs `W` `09a:4869` write the same path-copy loop twice.
The codebase already has the right pattern — `LoadImageW` (`09a7:214`), `MapVirtualKeyW`, `SetWindowsHookW`, `AddAtomW`, `GetAtomNameW` are thin wrappers; `$crt_itoa` (`09a6:429`) takes a `$wide` param.
*Fix:* adopt the wide-flag-core pattern; co-locate each W next to its A; fix SystemParametersInfoW as a correctness bug.

**wsprintf formatter family cloned wholesale for wide chars.**
`src/12-wsprintf.wat:5-225` (`$write_uint/$write_int/$write_hex/$apply_pad/$wsprintf_impl`) vs `:227-520` (`*_w` twins) — the entire ~220-line formatter duplicated with only store-width changes. *Fix:* parameterize on wide as crt_itoa does; halves the file.

**~969 hand-written stdcall epilogues, 100% derivable from api_table.json.**
Every `$handle_*` ends with `esp += 4*(nargs+1)`; 749/750 checkable handlers use exactly that formula with `nargs` already present in `src/api_table.json` (the one exception, `handle_LoadLibraryExA` at `09a:630`, is deliberate delegation). Project memory confirms epilogue drift is a recurring bug class ("drift causes wild jumps later").
*Fix:* have `tools/gen_dispatch.js` emit the ESP adjustment in the generated br_table after each handler call, with an opt-out for EIP-redirecting handlers. Deletes ~969 lines and the entire bug class.

**Control paint duplication with drift (09c3-controls.wat, 14,840 lines, 228 funcs):**
- **[BUG]** Two check-glyph implementations: button `09c3:4540-4578` (12×12, pen strokes) vs `$lv_paint_check_box` `:5872-5901` (13×13, fill_rect loop). The comment at `:5868` says "compose them the way the BUTTON painter does" — yet doesn't. 12 vs 13 px is a visible mismatch.
- **[BUG]** `$edit_view_metrics` (`09c3:11591`) subtracts 16 for WS_HSCROLL (`:11602-11605`); the same 8-line block re-derived inline at `:12367-12388`, `:12930-12938`, `:13176-13184` does **not** → divergent scroll extents.
- Scrollbar paint: `$scrollbar_ctrl_wndproc` re-implements `$paint_vscrollbar_rect` (`:14277-14322`) inline at `:14746-14838` and disagrees on thumb width (helper full-width, wndproc insets 2px). The helper *is* shared correctly at 4 other sites plus treeview — this one path bypasses it. `09c4-defwndproc.wat:480` re-implements the same fill/edge drawing a third time; `09c3:10006/12689/14385` carry comments promising to match "the same arrow=16 / track=h-32 geometry" painted elsewhere. `track_len` is computed 3× inline (`:14344,14361,14528`) and differently in `$sb_track_len` (`:14389`).
- fill+3D-edge: 31 `host_gdi_draw_edge` sites; the 5-line fill+edge block verbatim at 8+ sites; the shared `$gdi_draw_edge_desc` (`10-helpers.wat:9032`) is bypassed by all 31.
- God functions: `edit_wndproc` (1,393 lines), `listview_wndproc` (1,311), `listbox_wndproc` (952), `toolbar_wndproc` (730), `combobox_wndproc` (714), `button_wndproc` (681) — 6 functions ≈ 40% of the file.
- Repeated geometry: `hdc = hwnd + 0x40000` hardcoded 24×; `ctrl_get_wh_packed` unpacked inline ~29–32× (~90 lines, no accessor); ListBox re-derives `visible=(h-4)/16` inline 5× while ListView has helpers.

**[BUG] Duplicate Win98 system palette, already drifted.**
`$gdi_chrome_sys_color` (`10-helpers.wat:8642`) vs `$win98_sys_color` (`:16398`) encode the same palette twice; the chrome copy lacks entries 21/23/24 (3DDKSHADOW/INFOTEXT/INFOBK), so chrome paths return `0xC0C0C0` for tooltip backgrounds where the sys-color path returns `0xE1FFFF`. *Fix:* delete the chrome variant.

**Width-triplicated shift helpers.** `$do_shift32/8/16` (`src/05-alu.wat:66-306`) are three ~80-line copies differing only in width constants/masks — flag-semantics fixes must be applied three times. ~45 decoder `emit_*` functions (`src/07-decoder.wat:319-739`) are ~9 identical lines each differing only in handler indices; could be one emitter taking a handler-id pair. Total realistic core consolidation ≈ 1–1.5k of 33.5k lines — the cost is drift risk more than size.

**mixer A/W clones.** `mixerGetLineControlsA/W` (`09a7:12339/12387`, 42 of 48 lines identical), `mixerGetControlDetailsA/W` (`:12435/12457`), `mixerGetLineInfoA/W`, `mixerGetDevCapsA/W` — ~90 duplicated lines.

### 2.2 JS host layer

**Process boot/lifecycle implemented three times, diverged.**
`test/run.js:2256-2431` (stage→load_pe→init_dx_com_thunks→set_exe_name→set_winver→DLL graph walk→VFS seed) + `:5505-5692` (COM-DLL/LoadLibrary yield handlers); `host.js:966-1012` + `:1180-1360` (same boot + `handleComDllLoad`/`handleLoadLibrary`); a third slice at `index.html:2447-2517`. Divergence is behavioral, not stylistic: the CLI walks the DLL dependency graph transitively (`run.js:2377-2391`) and auto-preloads the exe's directory into the VFS (`:2441-2460`); the browser resolves only EXE-level imports through a hard-coded `availableDlls` URL map (`index.html:2483-2512`) and needs explicit per-app `files` lists.
*Fix:* `lib/process-boot.js` (load exe, resolve/load DLLs, seed VFS, pump yield reasons) consumed by both hosts; each host supplies only a `fetchFile` callback.

**Per-app config and hacks live in three places, per-host divergent.**
`index.html:1427-1710` (apps registry incl. `startupRegistry`/`startupIni` — browser-only), `test/run.js:223-276` (`applyExeCompatibilityPatches`, QuickBlackjack byte patches — CLI-only), `run.js:1892-1901` (NSIS title-sniffing inside `set_window_text`), `run.js:5049-5104` (Winamp IPC injection), `host.js:88-179` (`_cleanupWinampVisualizerThread` poking hard-coded guest addresses 0x458060/0x4595ac — browser-only). The same app gets different fixes depending on host.
*Fix:* one per-app profile module (JSON + one applier in lib/) both hosts load; guest-memory hacks move into profiles or WAT compat handling.

**Triplicated wiring inside the hosts.** Worker-import factory (`run.js:2153-2238` vs `host.js:727-800`); thread-import wiring (`run.js:2047-2059` vs `host.js:553-571`); API-name log decode (`run.js:1354-1370` vs `host.js:321-339`); the `ctx._windowText` Map maintained in **three copies** (`run.js:1843-1907`, `host.js:440-474`, `lib/host-imports.js:2986-2989`); `check_input` has three implementations (`run.js:1926-1972`, `host.js:477-550`, stub at `host-imports.js:3549-3551`). Of run.js's 6.4k lines, roughly 5k is genuine harness (flags, tracing, input DSL, debug REPL, dumps — fine where it is) and ~1–1.5k is duplicated host lifecycle/wiring that belongs in lib/.

**index.html embeds ~2,000 lines of application logic.** Apps registry (`1427-1710`), launch orchestration incl. hwnd-base allocation and LAN lobby (`2380-2530`), the whole DOM→renderer input bridge `wireCanvasInput` (`1821-2230`), debug MIDI player, canvas resize policy, SAB/threads gating — none of it markup, none testable from Node. Script loading uses hand-bumped cache-busters `?v=168`…`?v=207` (`index.html:657-677`) with a matching hand-maintained `SOURCE_VERSION = '207'` in `host.js:5`.
*Fix:* `lib/browser-shell.js`, `lib/browser-input.js`, and an `apps.json` shared with the CLI.

**lib/host-imports.js is six subsystems in one 4.3k-line closure.** Audio mixer/voice manager/MCI+MIDI sequencer (`208-1950`, ~1,700 lines of a software audio stack), HRGN region model (`1952-2185`), drawing + window management (`2948-3556`), GDI presentation (`3558-3830`), VLAN (`2499-2530`), tracing (`3918-4320`). The `require`-vs-`window.*` dual-loading dance (`:26-29`) is the structural reason nothing splits out — but the split pattern already exists and works (dib.js, gdi-surface.js, api-format.js).
*Fix:* extract `host-audio.js` and `host-window.js` the same way; import names stay one flat namespace.

### 2.3 Tools

**~24 hand-copied PE header/section parsers; no `lib/pe.js` exists.**
18 tools plus 6 test files each independently do `readUInt32LE(0x3c)` → section-table walk → VA↔offset mapping: `xrefs.js:32-52`, `find-refs.js:37`, `find_string.js:26`, `find_fn.js:24`, `dump_va.js:24`, `find_bytes.js:60-70`, `file2va.js:23`, `pe-imports.js`, `pe-sections.js`, `pe-exports.js`, `parse-rsrc.js`, `find_field.js:40`, `find_vtable_calls.js:47`, `vtable_dump.js:27`, `scan_fn_bounds.js`, `disasm_fn.js`, `aoe-hot-block-report.js:53`, `superinstruction-census.js:32`, plus test/. Subtle fixes exist in exactly one copy each: only `xrefs.js:28-29` knows the Borland "CodeSeg flagged as data" rule; only `dump_va.js` marks BSS ranges. The other ~20 copies silently lack them.
*Fix:* `lib/pe.js` with `{sections, imageBase, va2off, off2va, isCode}`; each tool drops ~30 lines and inherits the fixes uniformly.

**Three overlapping 4-byte-literal scanners.** `xrefs.js`, `find-refs.js:7-13`, and `find_bytes.js --imm32` all scan the image for the LE literal; two of the three also independently scan rel32 branches. Their real differences are flag-level (section filtering, classification, `--base=` exists only in find-refs) — and the Borland rule has already diverged between them. *Fix:* one `refs.js` over `lib/pe.js` with `--kind=data|branch|imm`; keep old names as aliases.

**caller_census.js scrapes another tool's human stdout.** `tools/caller_census.js:52-60` spawns `xrefs.js` and regexes its formatted output (`/^\s+(0x…)\s+\[.+?\]\s+branch/`); any print-format tweak silently yields "0 callers found". The aoe-* family shows the right pattern (imports `scanFile` from superinstruction-census). *Fix:* export the xref scan as a function.

**Instruction-classification duplicated alongside the shared disassembler.** `disasmAt` is properly shared (9 importers), but classification (what opcode precedes this literal / what ModRM shape) is re-derived per tool with different opcode coverage: `xrefs.js` `classifyDataRef`, `find_field.js:80-138`, `find_vtable_calls.js`, `find-refs.js`. *Fix:* expose `classify(buf, off)` from disasm.js.

---

## Part 3 — Hand-maintained invariants with no build check

The most likely source of the *next* mystery bug. Ordered by risk.

**3.1 Two build manifests, zero consistency check — and the documented build is not the real build.**
The shipped wasm compiles from the hand-maintained 45-entry `WAT_FILES` array (`lib/compile-wat.js:6-22`) via `tools/build-compile-wat.js` (`build.sh:22`); the `src/*.wat` glob only feeds `build/combined.wat` (`build.sh:18-19`), used by debug tools (`func-index.js`, `check-parens.js`, `wasm-func-name.js`). A new src file lands in combined.wat — so grep and check-parens see it — while the real build silently omits it. This has already happened once (project memory "WAT_FILES registry"). No checker compares the glob to WAT_FILES anywhere. Additional hazard: glob order can diverge from WAT_FILES order, shifting function indices in combined.wat vs the real module — `wasm-func-name.js:9-11` works around this by re-reading WAT_FILES, but `func-index.js` trusts combined.wat. CLAUDE.md's build section is wrong on both counts ("concatenates `src/parts/*.wat` … compiles with wat2wasm" — the directory is `src/` and wat2wasm appears nowhere in build.sh).
*Fix:* assert set-equality between glob and WAT_FILES in `build-compile-wat.js`; generate combined.wat *from* WAT_FILES order; update CLAUDE.md.

**3.2 Generated files regenerate manually; no freshness gate.**
Three artifacts must stay in lockstep — `api_table.json`, `01b-api-hashes.generated.wat` (name→id), `09b2-dispatch-table.generated.wat` (id→handler) — but `build.sh:8-22` runs only check-handler-count, check-handler-esp, cat, compile; never `gen_dispatch.js`/`gen_api_table.js`. `tools/check-hash-table.js` exists and is wired nowhere. CLAUDE.md's add-an-API recipe omits `gen_api_table` entirely, so following the documented procedure leaves the hash table stale and the new API unfindable. (Currently in sync — 2,462 entries each, verified — but only by discipline.)
*Fix:* build.sh regenerates both (generation is deterministic and cheap), or at minimum runs check-hash-table.js.

**3.3 api_table.json id fragility; gen_api_table is a second source of truth that rewrites its own input.**
Ids are literally array position (`id == index` for all 2,462 entries, verified); `gen_api_table.js:1064-1076` renumbers on every run, so a mid-array insert rewrites thousands of lines and invalidates every compiled hash table — the append-only rule lives only in a memory note. Worse, `gen_api_table.js:44-1058` carries ~1,000 lines of embedded API definitions merged into the json it also reads, so "which is authoritative" depends on what was edited last. And the one structural invariant that matters at runtime — COM vtable methods contiguous per interface — is checked but only **warned** (`gen_dispatch.js:138-144` prints WARNING and keeps generating a broken table).
*Fix:* `check-api-table.js` in build.sh asserting `id === index` + append-only-vs-git-HEAD; promote the contiguity warning to `exit(1)`; long-term drop the stored `id` field.

**3.4 Ordinal-import strings addressed by hand-computed absolute offsets.**
`$system_ordinal_api_id` (`src/08b-dll-loader.wat:264-306`) maps ~40 ordinals to API ids via literal offsets (`0x1130C`, `0x11317`, …) into 01-header's data segment. Inserting or lengthening any earlier string silently shifts every later offset and breaks ordinal resolution at *runtime*. `tools/data_offsets.js --check` exists precisely to audit this but is manual-only.
*Fix:* run it as a build gate, or resolve these strings through the existing FNV hash table.

**3.5 14 slot-parallel window tables reset by a hand-written 13-call list.**
`src/09c-help.wat:65-78`. A new per-slot table not added there means stale state on slot reuse — silent, timing-dependent. *Fix:* a data-driven slot-reset registry (table base + stride pairs walked in a loop).

**3.6 Control-class identity implemented 3–4×; the authoritative id list exists only as a comment.**
`09c-help.wat:422-455` (packed LE dwords + atoms 0x0080–0x0085), `09a5-handlers-window.wat:336-400` (same → numeric ctrl ids 1..21 — the id mapping lives **only in the comment** at `:340-342`), a third resolver at `09a:5461`, and `$richedit_class_version` (`09c-help.wat:463`) as a fourth matcher. Consumers: `$ctrl_table_get_class` has 67 calls across 8 files. *Fix:* one `$class_name_to_ctrl_id` used by all.

**3.7 State-table encapsulation is inconsistent.**
The good news: table *bases* are always reached via globals (no bare `0x7000` literals), and WND_RECORDS is well-encapsulated — `$wnd_record_addr` (`09c-help.wat:21`) is the only `global.get $WND_RECORDS` site, field accessors used ~230×. The leaks:
- **SCROLL_TABLE: zero encapsulation** — 17 raw `base + slot*24` sites across 4 files (`09a:10637-10795`, `09c3:5522…14799`, `09c4:643`, `13-exports:3484-3500`), plus 5 SCROLL_AUX sites at a *different* stride (16) for the same slot.
- **CONTROL_TABLE: accessors exist and are re-implemented anyway** — `09a5:562` and `13-exports:3623` re-implement `$ctrl_table_set_id`/`get_id` (canonical at `09c3:571/560`); `09a:2207` is a third copy; 13 raw `slot*16` sites in 4 files.
- **The state struct is the real magic-number problem**: 481 raw `offset=N ($sw)` + 259 `offset=N ($state_w)` accesses over 19 distinct offsets with no named accessors (`offset=20` means "top index" in listbox, combobox, *and* edit).
- **PAINT_SCRATCH**: one shared 16-byte RECT used at 136 sites in 7 files; the reentrancy hazard is acknowledged in a comment (`01-header.wat:1239`) and unenforced.

**3.8 Duplicated state / dual ownership.**
- Window rect has two owners: children in CONTROL_GEOM, top-levels in the JS host via `host_get_window_rect` — branch at `10-helpers.wat:15144-15158`; `renderer.windows` is a second window tree mirroring WND_RECORDS with sync seams both directions (`lib/host-imports.js:3477-3492` `sync_window_client`; `get_window_rect:3335-3400` prefers WAT exports for children, JS `win.x/y/w/h` for top-levels).
- Main-window geometry lives in globals parallel to WND_RECORDS: `$main_hwnd, $pending_wm_size, $main_win_cx/cy, $main_nc_height` (`01-header.wat:1767-1788`); `09a:11216-11231` fills CREATESTRUCT from them. Forks every code path into main-vs-other and adds per-thread propagation burden (per-instance globals!).
- EDIT scroll state stored twice (`state_w+20` then mirrored to SCROLL_TABLE via `$edit_publish_scroll_info` `09c3:11571-11584`); LISTVIEW same; WinHelp scroll is a third form (global `$help_scroll_y`, 20 sites in 4 files).
- GWL_STYLE's WS_VISIBLE synced with host visibility by promise-comments at `09a:3169` and `09a:3418`.

---

## Part 4 — Performance

### 4.1 Interpreter hot loop (every app, all the time)

**`$fast_msvc_sbh_scan` runs before every block dispatch, forever.**
`src/13-exports.wat:156` → `src/10-helpers.wat:163-235`. Per dispatched block: a `g2w(eip)`, ~17 memory loads and 16 compares against the byte signature of one specific MSVC small-block-heap loop — with no early-out (all 8 checks of variant 1 run, then all 8 of variant 2, via `local.set $match` instead of branching). At tens of millions of blocks/sec this is likely the single largest fixed tax in the outer loop, paid by every app whether or not it is MSVC-compiled.
*Fix:* the bytes are static code and decode already reads them — detect the pattern once in `$decode_block` and emit a dedicated handler opcode. Steady-state cost drops to zero.

**~15 debug conditionals per basic block in release mode.**
Every block ends by unwinding to `$run` (`$th_jmp`/`$th_jcc*`/`$th_ret` at `05-alu.wat:749-880` do not continue the tail-call chain), so per block the loop re-runs: watchpoint (`13-exports.wat:23`), yield_flag (30), bp compare (37), hit-counter loop head (50), two code16 checks (69, 99), a 4-way yield_reason OR (87), thunk-range check (110), two `dbg_prev` stores (136-137), trace_esp/trace_eip (139, 147), hist (154), the SBH scan (156), `cache_lookup` (158); plus `steps` reset to 1000 (165) and re-tested per instruction inside `$next` (`04-cache.wat:107-108`). With typical 5–10 instruction blocks, that's a large constant per instruction.
*Fix:* collapse the rarely-true flags into one `$any_debug` global tested once, cold-path the chain; longer-term, block chaining (patch the decoded successor pointer into the thread stream on first execution) lets unconditional jmp/fallthrough skip the outer loop and cache_lookup entirely.

**Memory-form ALU handlers re-dispatch decode-time constants at runtime.**
Register-register/immediate forms are specialized per opcode (`$th_add_r_r` etc., `05-alu.wat:378-440`) — but all memory forms funnel through generic handlers (`$th_alu_m32_r_ro`, … at `06-fpu.wat:1175-1243`) that per execution unpack the ALU op and walk the 7-branch chain in `$do_alu32` (`05-alu.wat:5-64`), plus 1–3 calls to `$get_reg`/`$set_reg`, each itself a 7-branch chain (`03-registers.wat:4-24`). A single `cmp [ebp+8], esi` costs ~7 calls and ~15 data-dependent branches for information the decoder knew statically.
*Fix:* specialize the hottest memory forms per-op (the handler table has headroom; the handler histogram at `04-cache.wat:135` can identify which); convert `$get_reg`/`$set_reg` to `br_table`.

**App-specific accelerations baked into the generic core.**
`$decode_block` special-cases two literal guest EIPs `0x0049D9D1`/`0x0049DD20` (`07-decoder.wat:771-784`, gated by `stack_packet_enabled`) — one binary's function addresses compiled into every app's decoder; the MSVC SBH scan is the same category by byte-signature. Neither is registered anywhere discoverable; a different build of the target exe silently stops matching.
*Fix:* a small data-driven table (addr → handler id) populated from JS at load; the WAT core stays app-agnostic.

**Secondary (measure before investing):** the 4,096-entry direct-mapped block cache (`01-header.wat:1546-1547`) collides at 16KB stride, and the arena-full policy wipes *all* decoded code (`13-exports.wat:18-21`, `04-cache.wat:69-77`) — apps with >4MB of hot decoded code pay periodic full re-decode. Check the `0xCA00F10F` overflow-marker frequency first.

### 4.2 Browser run loop

**The `setTimeout(step, 0)` chain hits the 4ms nested-timer clamp.**
`host.js:1560,1571,1576,1675`; no MessageChannel/postTask anywhere. Browsers clamp nested timers to ≥4ms after depth 5, capping the drive loop at ~250 steps/s; with the documented p50 step of 2.3ms the main thread idles >50% of each cycle.
*Fix:* drive the fast path with a MessageChannel port (unclamped macrotask, still yields to input/rAF); keep rAF for repaint coalescing. Probably the single biggest guest-throughput lever available.

**Repaint is scheduled unconditionally every step and is always a full-desktop composite.**
`host.js:1525-1527,1646-1648` → `renderer.js:1429-1433` (unconditional `scheduleRepaint`) → `_repaintOnce` (`renderer.js:1475-1576`): `Object.values(windows)` + filter + sort + per-window `_syncWindowStyle`, then full back-canvas blits — even for a fully idle app, at 60Hz, with per-frame garbage. Dirty knowledge already exists one layer down (`surface.takeDirtyRect()`, `host-imports.js:154`) and is discarded at the compositor.
*Fix:* renderer-level dirty flag set by the paths that mutate pixels/geometry; skip when clean; optionally clip composite to the union dirty rect.

**Per-call garbage in hot imports; per-step allocations.**
- `draw_text` constructs a **new TextDecoder per call** (`host-imports.js:2958`).
- 61 `new DataView`/`new Uint8Array` sites in host-imports despite fixed-size memory (`run.js:2038`: initial=maximum → a cached view never invalidates).
- `host.js:1438-1461` `_hasOpenMenu` builds a Set + array + calls a WASM export per instance **every step** with active threads.
- `host.js:477-530` `check_input` allocates closures per call on the GetMessage poll path.
- `run.js:1987-2035` installs trace shims on `get_window_rect`/`get_mouse_position`/`get_async_key_state` (games poll these hot) even when the flags are off — the `wrap`/`waveWrap` pattern already shows flag-gated installation.

**`logToUI` is quadratic DOM append on the input path.**
`host.js:579-586` does `el.textContent += msg` — re-materializes the entire unbounded log text and forces layout per call — fed by every non-mousemove input event (`:527`), every CreateWindow/SetWindowText (`:445,468`), and the `[run]` heartbeat (`:1543`). Long sessions degrade steadily. *Fix:* append text nodes / capped ring buffer; gate behind debug mode.

**Synchronous XHR on the browser main thread.** `host.js:263-271` — `xhr.open(..., false)` when the VFS misses; blocks the UI thread on a network round trip, invisible to the perf HUD's phase marks. The yield mechanism exists for exactly this (it's how DLL loading works). *Fix:* yield → async fetch → resume.

### 4.3 "All logic in WAT" violations (architecture + perf both)

`lib/host-imports.js` implements real Win32 semantics in JS: `get_window_related` implements GetWindow GW_* walks over `renderer.windows` (`3150-3199`); `arrange_windows` implements Cascade/Tile math (`3230-3310`); `move_window` carries SWP flag semantics, CW_USEDEFAULT policy, z-order policy, plus MFC class-name-specific clamps for `toolbarwindow32`/`afxcontrolbar42` (`3401-3475`, clamp duplicated in `set_parent:2975-2983`); `renderer-input.js` decides modal blocking, dialog hit-tests, capture/focus routing (`951-1100`). Every geometry heuristic patch lands in JS because authority is split (see 3.8). `host.js:588-630` `_getVersionInfo` linear-scans 2MB of guest memory for `VS_VERSION_INFO` in JS — a scan, not a resource-tree walk, contradicting the resources-in-WAT principle.
*Direction:* make WAT the single authority for geometry/z/visibility (exports already exist: `wnd_window_screen_x/y`, `wnd_screen_w/h`, `get_client_rect_wh`); shrink JS window records to canvas/back-canvas bookkeeping.

---

## Part 5 — Dispatch-layer inconsistencies

Five competing dispatch styles coexist:

1. The generated br_table (`09b2-dispatch-table.generated.wat:6`, pages `:52/:1084/:2116/:3148`) — the good one; all 364 `$handle_*` in 09a7 reachable, **zero orphans** against api_table.json.
2. Char-offset name-sniffing sub-dispatchers: `$dispatch_local` (name+5), `$dispatch_global` (name+6), `$dispatch_lstr` (name+4), `$dispatch_reg` (name+3) — `09a7:8/29/55/127`. Callers are already name-resolved stubs (`09a:4210-4234` etc.), so the table resolves the name and the sub-dispatcher re-parses the string — a redundant second layer with three different offsets. Documented cost: the Win16 bridge "has no name to give it" (`09e-win16-api.wat:360-365`) and so reimplements lstrcpy/lstrcat/lstrlen instead of bridging, while its neighbors cleanly call `$handle_GetPrivateProfileIntA`.
3. The `0xCACA00xx` continuation-thunk if/else chain, ~25 branches (`09b-dispatch.wat:23-730`) — fine, it's a different mechanism.
4. Hardcoded numeric api_id fast paths before the table: ids 490/491/470 = PeekMessageA/W, MsgWaitForMultipleObjects (`09b-dispatch.wat:786,800,812`) — raw positional ids with no guard in gen_dispatch.js, each re-duplicating the register-restore epilogue (`:794,806,833,851`). A silent break if ids ever renumber (see 3.3).
5. COM vtable→api_id arithmetic (`gen_dispatch.js:138-168`) — fine, and auto-computed.

Membership in style 2 is historical, not principled: all 6 wide `lstr*` are plain handlers while 6 ANSI ones route through `$dispatch_lstr`; `LocalSize` is plain but `GlobalSize` routed. Latent hazard: `$dispatch_global` keys on byte 6, aliasing GlobalAddAtomA↔GlobalAlloc and GlobalFindAtomA/GlobalFlags↔GlobalFree — safe today only because those happen to have separate handlers. And `GlobalCompact`'s branch (`09a7:52`) is unreachable (its handler crashes unimplemented).
*Fix order:* delete `$dispatch_reg` (dead, see Part 6); inline the 17 remaining sub-dispatch branches into their `$handle_*` and delete the three sub-dispatchers; emit named api_id constants from gen_dispatch.js for 09b's fast paths and factor the epilogue.

---

## Part 6 — Dead code

Confirmed zero call sites module-wide and not JS-exported (~160 lines, 10 functions):

| Function | Location | Note |
|---|---|---|
| `$dispatch_reg` | `09a7:127-150` | all 26 Reg* APIs have real handlers |
| `$ole_bindctx_bound_find` | `09a7:3026` | |
| `$post_queue_dequeue` | `09a:166` | leftover of the shared_post_queue refactor; siblings at `:185/:200` are live |
| `$create_stub_dialog` | `09c3:1691` | callers at `:1723/:1771` build their own |
| `$edit_wrapped_line_count` | `09c3:12028` | superseded by `:11614` |
| `$help_navigate` | `09c-help:1339` | |
| `$help_subslice` | `09c6:911` | |
| `$menu_first_selectable` | `09c5:2240` | |
| `$menu_subchild_shortcut_ptr/_len` | `09c5:783/795` | |

Plus `tools/check-hash-rt.js` (hardcodes obsolete address `0x01362000`, prints advice rather than checking anything). Careful negatives, verified live: `$stub_wndproc` (dispatch class 13), the `tab_native_*`/`statusbar_native_*` families (called from 09a5 and 10-helpers), the exported `menu_handle_*` functions (called by `lib/renderer-input.js:1019,1213,2200`), and `lib/canvas-compat.js` (18-line alias, kept for the filename).

---

## Part 7 — What's healthy (keep doing this)

- **String ops** (`05b-string-ops.wat`): bulk `memory.copy`/`fill` fast paths with correct contiguity/overlap guards.
- **WND_RECORDS**: single address-computation choke point, ~230 accessor uses. The model the other tables should copy.
- **`check-handler-count.js` / `check-handler-esp.js`**: real build gates, wired into build.sh, fail loudly. The model the other invariants should copy.
- **The generated dispatch**: zero orphans, COM start-ids auto-computed.
- **Tool-family sharing where it exists**: aoe-* imports `scanFile`; hlp-* shares `lib/hlp-parser.js` (hlp-dir.js's standalone parser is deliberate — it must read files the parser rejects); `disasmAt` shared by 9 tools.
- **skia-canvas removal is complete**: deps are `wabt` + `pngjs` only; `lib/raster-canvas.js` is the pure-JS surface.
- **The A/W wrapper pattern exists** (LoadImageW, crt_itoa, etc.) — it just needs to be applied to the other 47 pairs.

---

## Prioritized recommendations

**Tier 1 — build gates (an afternoon; closes the silent-drift category):**
1. Assert WAT_FILES ↔ `src/*.wat` glob set-equality in the build; generate combined.wat from WAT_FILES order. (§3.1)
2. Regenerate (or verify) `01b`/`09b2` from api_table.json in build.sh; wire in check-hash-table.js. (§3.2)
3. `check-api-table.js`: `id === index` + append-only vs git HEAD; promote gen_dispatch's COM-contiguity warning to a hard failure. (§3.3)
4. `data_offsets.js --check` on the ordinal-string offsets as a build gate. (§3.4)
5. Fix CLAUDE.md's build section (src/ not src/parts/; compile-wat.js not wat2wasm) and the add-an-API recipe; delete check-hash-rt.js. (§3.1, §3.2, §6)

**Tier 2 — mechanical deletions and generation (low risk, high payoff):**
6. Generate the ~969 ESP epilogues from api_table.json nargs. (§2.1)
7. Delete the 10 dead functions and the three name-sniffing sub-dispatchers; named api_id constants for 09b's fast paths. (§5, §6)
8. Fix the five confirmed divergence bugs: SystemParametersInfoW stub, edit WS_HSCROLL metrics, tooltip palette entries, 12/13px check glyph, GetMessageW's missing phases. (§2.1)

**Tier 3 — performance (measured levers):**
9. Browser: MessageChannel drive loop; dirty-flag repaint; cached TextDecoder/DataViews; event-driven `_hasOpenMenu`; async VFS-miss reads; ring-buffer logToUI. (§4.2)
10. Interpreter: move the MSVC-SBH scan to decode time; `$any_debug` gate for the per-block checks; then per-op specialization of hot memory-form ALU and br_table register access. (§4.1)

**Tier 4 — structural (do gradually, file moves are zero-risk here):**
11. Split the three mislabeled giants: 10-helpers → gdi-* files (+ move wordpad/menu tail), 09a7 → ole file, 09c-help → window-table file; rename the 249 `$host_gdi_*` non-imports; relocate 09a's GDI/comctl32/menu slabs and 06-fpu's non-FPU handlers. (§1)
12. Unify the A/W pumps around `$getmessage_core(wide)`; wide-flag the 47 independent A/W pairs and wsprintf. (§2.1)
13. Extract `lib/process-boot.js`, a shared per-app profile registry, `lib/browser-shell.js`/`browser-input.js`; split host-audio/host-window out of host-imports.js. (§2.2)
14. Accessor layer for SCROLL_TABLE + named state-struct offsets; data-driven slot-reset registry; single control-class id table; move main-window geometry into WND_RECORDS. (§3.5–3.8)
15. Longer arc: single geometry/z/visibility authority in WAT; JS window records shrink to canvas bookkeeping. (§4.3)

---

## Status — what was acted on

*Updated 2026-08-18 after a pass over this review. Commit hashes are on `main`;
a few unrelated commits from a parallel session are interleaved in the log.*

**Done**

| § | Item | Commit |
|---|---|---|
| 3.1–3.4, 6 | All four missing build gates (WAT_FILES↔glob, api_table id/append-only, generated-dispatch freshness, hash table, ordinal data strings); COM-contiguity warning promoted to fatal; `check-hash-rt.js` deleted; CLAUDE.md build section and add-an-API recipe corrected | `5ac7943` |
| 2.1 | SystemParametersInfoW stub (+ the A path's NONCLIENTMETRICS layout, which placed five LOGFONTs inside each other), 12/13px check box, edit WS_HSCROLL metrics, duplicated Win98 palette | `0652b8a` |
| 5, 6 | `$dispatch_local/global/lstr` deleted, 17 handlers given their own bodies; 10 dead functions removed; new `tools/wat-func.js`. Exposed a wrong `nargs` for GlobalSize in api_table.json | `964df31` |
| 4.1 | MSVC-SBH scan moved to decode time; six per-block debug flags behind one `$dbg_any`; br_table for `$get_reg`/`$set_reg`/`$do_alu32`; the two hardcoded guest EIPs out of `$decode_block` | `f7f719f`, `6a9a229`, `55b637d` |
| 4.2 | MessageChannel drive loop (the 4ms nested-timer clamp), dirty-gated repaint, cached TextDecoder, ring-buffer `logToUI`, cached `_hasOpenMenu`, memoized VFS-miss fetch, flag-gated trace shims in run.js | `b724a89` |
| 2.3 | `lib/pe.js` — one PE reader for 17 tools, carrying the Borland code-section rule and BSS marking that each lived in one copy; `scanXrefs()` exported so `caller_census.js` stops parsing printed output | `5ed4e2e` |
| 1 | `10-helpers.wat` → four `10*-gdi-*.wat` files; `09a7` → `09a7b-ole.wat` + `09a7c-mixer.wat`; `09c-help` → `09c0-window-table.wat`; `06-fpu`'s non-FPU handlers → `06b-core-handlers.wat`; 09a's comctl32 slab → `09a9-comctl32.wat`. New `tools/wat-split.js` | `1c75b2f`, `661b8c1`, `6eb9ece`, `430d3ed` |
| 2.1 | wsprintf: one formatter parameterized on `$wide`, 520 → 290 lines | `9a9987a` |
| 2.1 | The W message pump deleted — GetMessageW/PeekMessageW/DispatchMessageW were stale forks missing WM_NCPAINT, the VLAN pump, timers, the post queue, and status-bar/tab dispatch | `75bf280` |
| 3.5, 3.7 | SCROLL_TABLE/SCROLL_AUX accessors; one `$wnd_slot_reset` — which turned out to be missing four tables, so a recycled slot inherited scroll range, flash and maximized state | `0b6fa45`, `5c59649` |
| 2.1 | One `$paint_sb_thumb` for both scrollbar painters (the control inset its thumb 2px, the shared painter did not); `$ctrl_get_w`/`$ctrl_get_h` | `83fef1b`, `7ddc9fa` |
| 2.2 | `lib/dll-registry.js` — one loadable-DLL list; the browser's copy had 14 names to the CLI's 32; window-title bookkeeping collapsed from three copies to one | `125e25d`, `53b4e4e` |
| — | Extras this pass earned: the build now validates the wasm with `WebAssembly.Module` (it was shipping modules that failed to instantiate), `check-handler-esp` reads every part instead of ten named files, and `test/run-all.sh` runs a tier N-at-a-time | `83fef1b`, `f93ebba`, `dc37c8d` |

**The three I first declined, then did**

- **09a's scattered GDI and menu handlers (§1.4).** Declined because they could
  not be moved as a range; that was a tool limitation. `wat-split.js --names=`
  moves a set in one pass, so all 35 menu handlers went to `09c5-menu.wat` and
  all 116 GDI handlers to `09a4-handlers-gdi.wat` (`185afb3`). 09a-handlers.wat:
  12,940 → 11,012 lines.
- **`$do_shift32/16/8` (§2.1).** Declined because the three differ in
  sign-extension, rotate-modulo and RCL/RCR carry width. They are now one
  `$do_shift(bits, …)`, merged under a differential test: the originals were
  kept as `_ref` copies and every one of 29,376 (width, op, value, count,
  carry) combinations was compared on result *and* CF/ZF/SF before the copies
  were deleted. `test/test-shift-equivalence.js` keeps the coverage against an
  independent model (`747ddd1`).
- **Generating the ~969 epilogues (§2.1).** Done, but *into the handler*, not
  into the dispatch table (`a33f44a`). The caller-side version was implemented
  and backed out after it broke WordPad and TWorld; the four reasons are in
  that commit and in `tools/esp-epilogue.js`. The last one is worth repeating:
  with 113 of the "provably simple" handlers converted WordPad crashes in
  HeapAlloc, with 112 it does not, and the 113th is safe on its own. Static
  shape does not predict it. `--check` now verifies all 1,325 epilogue lines
  against `nargs` in the build, and `--sync` rewrites drift.

**Still open**

- §2.2 `lib/process-boot.js`, the per-app profile registry, `lib/browser-shell.js`,
  and splitting `host-audio`/`host-window` out of `lib/host-imports.js`. The DLL
  list is now shared, which is the prerequisite for sharing the transitive DLL
  walk the CLI has and the browser does not.
- §2.1 the remaining 47 independent A/W handler pairs.
- §3.6 one control-class id table (three matchers answer two different
  questions; collapsing them changes which classes count as built-in).
- §3.7 named accessors for the control state struct — the offsets mean
  different things per class, so this is a per-class job, not one rename.
- §3.8 and §4.3, the dual-ownership and JS-authority arcs. Multi-session.
- §4.2 the VFS-miss read is memoized but still synchronous; making it
  yield-and-resume is the real fix.
- `test-all-exes`'s screensaver check is unstable — two runs of identical code
  gave 105 and 103 PASS, with different MFC screensavers flipping to BLANK.
  Worth chasing before trusting that number.
