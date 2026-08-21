# Wine-Assembly — The Whole Story

*A retrospective from the initial commit (2026-03-26) through 2026-08-19: 2,131 commits across 147 calendar days and 90 active commit days.*

---

## 0. The premise

> Run real Windows 98 `.exe` files in the browser. No source, no recompilation, no porting layer. Just raw WebAssembly Text interpreting x86 machine code, with the Win32 API reimplemented inside the WASM module itself.

This is the kind of project that "shouldn't" be a sprint at all. It started as a single WAT file. It is now about 150k lines of WAT across 54 parts plus 122k lines of browser, test, and tooling JavaScript. The 114-binary smoke matrix spans Win98/XP accessories, MFC applications, games, installers, screensavers, DirectDraw, Direct3D Immediate/Retained Mode, audio, RichEdit, and OLE — and since Aug 15 it is no longer only a 32-bit story: 16-bit NE images load, link and run, so the original Windows Entertainment Pack plays in the browser next to its 32-bit remake.

The history is also a record of AI-assisted systems work. The implementation is **coded directly in WAT**—there is no C/Rust-to-WASM emulator build—but it should not be described as solely "hand-written." Large parts of the reverse engineering, code, tests, and design were produced through sustained collaboration with Claude Code and Codex. This retrospective was refreshed from all three available records: Git, the repository's Claude session history/memories, and Codex rollout transcripts. The final week is visibly a *multi-agent* record: up to six sessions worked the same tree at once, coordinating through an append-only `messageboard.txt` and building every commit in a throwaway `GIT_INDEX_FILE` so nobody swept up a neighbour's in-flight edits.

---

## 1. The arc, in thirteen acts

```
Act I     Mar 26-28   Decoder, lazy flags, FPU, SEH        →  Notepad runs
Act II    Mar 29-31   DLL loader, GDI, MSPaint MFC         →  CRT init completes
Act III   Apr 01-04   Multi-app shell, COM, NSIS           →  23 PASS / 12 FAIL
Act IV    Apr 05-09   Controls-as-windows refactor         →  Logic into WAT
Act V     Apr 10-15   DDraw, audio, dialogs, Winamp        →  Skinned UIs + sound
Act VI    Apr 16-21   Message-queue routing, perf, dialogs →  AoE/MCM boot; D3DIM rasterizer
Act VII   Apr 22-28   D3DIM real, TileWorld, comboboxes    →  Plus!98 + DX SDK in flight
Act VIII  Apr 29-May 06 Paint/DC ownership, Pinball, MIDI   →  Real input/audio + WAT clipping
Act IX    May 07-29   Web/mobile shell, Winamp, RCT        →  Safari/PWA + installer/audio polish
Act X     Jun 01-18   AoE profiling, D3D3/D3D7 breadth    →  Broad 3D and app smoke coverage
Act XI    Jul 06-30   Safari regressions, RichEdit start   →  WordPad becomes a real target
Act XII   Aug 01-12   WordPad/OLE, Paint, accessories      →  Desktop workflows + software GDI
Act XIII  Aug 13-19   Fonts, WinHelp, Win16, LAN, de-drift →  Canvas text deleted; NE runs; two
                                                              emulators play each other
```

### Commit cadence

```
03-26 ████████████▌                  13   ◄ initial commit
03-27 ███████████████████████████████████   35
03-28 ████████████████               16   ◄ FPU, byte regs, BITMAP
03-29 ███████████████████████        23   ◄ DLL loader lands
03-30 ▌                               1
03-31 ███████████████████████████████  31  ◄ MSPaint MFC pipeline
04-01 ██████████████████████         22
04-02 ███████████████████████        23
04-03 █████████████████████████████████████████████████  49 ◄ peak: pure-JS WAT compiler,
                                                              berrry deploy, multi-app desktop
04-04 ████████                        8   ◄ tail-call dispatch (~40% faster)
04-05 ███                             3
04-06 ██████████████████████         22   ◄ Win98 Tour, RegEdit, MSPaint NT pass
04-08 ████████████████████████████████  32 ◄ Controls-as-windows refactor begins
04-09 ███████████████████████████████████████████  43 ◄ Phase 2 menus into WAT
04-10 ██████████████████████████     26
04-11 ██████████████████████████████████████  38 ◄ Spider playable, screensavers,
                                                    desktop icons from PE
04-12 ███████                         7
04-13 ██████████                     10
04-14 █████████                       9
04-15 ███████████████████            19   ◄ kill JS fallbacks, dialog WAT-native
04-16 ████████████████████████████████████████████████  48 ◄ memory relocation +32MB, operand-size audit,
                                                              message-queue Phases 0-7, AoE main loop
04-17 ████████                        8
04-18 ███████████████████████████    27   ◄ MCM hInstance fix, per-module rsrc
04-19 ███████████████████████████████████  35  ◄ D3DIM real: viewports, lights, Execute opcodes;
                                                    8bpp surface GDI round-trip
04-20 ████████████████████████████████████████████████  48 ◄ D3DIM rasterizer + back-face cull,
                                                              85× SetDIBitsToDevice perf, scrollbars
04-21 ██████████████████████████     26
04-22 ███████████████████████        23   ◄ Notepad dialogs: About/Find/Open/Font/Color render
04-23 █████████████                  13
04-24 ███████████████████████        23   ◄ D3DIM Execute ops, real matrix table, STATETRANSFORM
04-25 █████████                       9   ◄ TileWorld boots end-to-end (SDL 1.x via real semaphores)
04-26 ████████████████████████████████████████████████████████  56 ◄ typed API tracing, real MessageBoxA,
                                                                       FPU env ops, paint flag table,
                                                                       dialog focus traversal
04-27 █████████████████████████████████████████████  45   ◄ combobox state machine, WS_POPUP shell,
                                                              double-translation fix cluster
04-28 ███████████████████████        23   ◄ maximize/restore, 0x67/GS trap, pinball combo dropdown
```

The original daily chart ended there. The continuation was burstier rather
than a single uninterrupted sprint:

```text
04-29..30   65 commits  Pinball input, RCT, D3DRM, region-driven paint
May        212 commits  MIDI, installer, mobile/PWA, Winamp, RCT/AoE
June      118 commits  AoE performance work, D3D3/D3D7, broad smoke promotion
July       19 commits  Safari fixes and native WordPad/RichEdit bring-up
08-01..12 152 commits  WordPad/OLE, Paint, RegEdit, audio apps, Task Manager
08-13      57 commits  GDI ownership lands in WAT; OLE clipboard; bitmap fonts
08-14     154 commits  TrueType + WinHelp + virtual LAN, all three at once
08-15      85 commits  WAT text path only; NE loader; help viewer runs
08-16      94 commits  16-bit apps reach WinMain, then their message loops
08-17      53 commits  DDEML, menu sweep across the corpus, threads probe
08-18      76 commits  Architecture review, then de-drift: A/W merge, file splits
08-19     113 commits  Win16 breadth, VB games, web desktop cleanup

The peak day is now Aug 14 (154 commits), which displaced Apr 26 (56). The last
seven days carried 632 commits — 30% of the project's entire history — with up
to six agent sessions committing into one worktree at once.
```

---

## Act I — "Will this even decode x86?" (Mar 26–28)

The first commit on **Mar 26 02:11** is a single WAT file: a Forth-style threaded code dispatcher. By 03:07 the same day there's a "rewrite x86 decoder for full i486 ISA coverage" commit. Notepad is the target.

**Day 1 (Mar 26):**
- Initial commit: threaded interpreter
- Decoder rewrite, SIB addressing, 0x66 prefix
- Win98 canvas renderer ("resource-driven GUI host imports")
- SEH exception handling, interactive debugger
- Mouse events + persistent message loop
- C++ exception unwinding ("trylevel matching and catch-return thunk")

**Day 2 (Mar 27):** 35 commits. Notepad goes from "decodes" to "edits text":
- Keyboard input + Edit child window
- Critical IMUL r,[mem] bug (clobbered destination register)
- INC/DEC CF preservation, ADC/SBB carry overflow, MUL/IMUL flags
- Menus (dropdown, accelerator underlines, Alt+F+X navigation)
- Caret blinking at 530ms, Ctrl+A select all, double/triple-click
- Window dragging, modal About dialog
- ShellAboutA reads from PE resources
- Edit control scrolling, word wrap, vertical scrollbar

**Day 3 (Mar 28):** 16 commits. The bedrock gets serious.
- x87 FPU with full arithmetic
- OF/SF for 8/16-bit ops, shift CF storage, IDIV overflow
- ROL/ROR/RCL/RCR
- POPFD via raw flags mode
- WASM-level watchpoints
- Free-list allocator, BT memory ops, FPU transcendentals
- Real bitmap resource loading + BitBlt pixel copying
- **Split `main.wat` into 13 modular parts** (the layout that exists today)
- Table-driven O(1) br_table dispatch for Win32 calls

By the end of Act I, Notepad and Calc work end-to-end and the project has its file structure.

---

## Act II — "MFC is real" (Mar 29–31)

The story shifts from "implement opcodes" to "implement the OS." Targets are SkiFree, MSPaint, and the Entertainment Pack.

```
Mar 29  16-bit (66-prefix) MOV reg/mem variants
        DLL loader + 70 new API stubs
        TLS, critical sections, interlocked ops → MSPaint CRT init completes
        FIX: 16-bit MOV reg,reg bug corrupting SkiFree heap
        FIX: API_HASH_COUNT off-by-one (lstrcpynW hit fallback)
        FIX: 16-bit ALU flag_res not masked

Mar 30  ScrollWindow, shared host imports module

Mar 31  Windows-correct WM_ERASEBKGND, BitBlt ROPs
        MoveWindow for SkiFree
        Source-less ROPs, DC state tracking
        Rewrite x86 disassembler with proper prefix handling
        MSPaint MFC init: thunk dispatch, dynamic thunk bounds
        Canvas-backed GDI bitmaps (Pegged renders)
        Save/restore client area pixels around menu dropdown
        Font object support: CreateFont, font-aware text metrics
```

The recurring pattern is now visible: hit a crash → grep the disasm → implement the API for real. **No silent-stub policy** is born here — every unimplemented call traps via `crash_unimplemented` so the next session starts at a real address, not silent corruption.

---

## Act III — "Make it a platform" (Apr 1–4)

This is when wine-assembly stops being a notepad emulator and starts being a Win32 host.

**Apr 1:**
- Cdecl calling convention for CRT
- **Virtual registry + INI files backed by `localStorage`**
- Minesweeper XP: PASS
- Encode hwnd into window DC handle (`hdc = hwnd + 0x40000`) — the trick that makes multi-window GDI tractable
- **Multi-instance threading**: imported memory, ThreadManager
- Child window support: WM_CREATE/WM_SIZE/WM_PAINT delivery
- Monochrome bitmap support

**Apr 2:**
- 14 silent stubs converted to `crash_unimplemented` (the policy bites)
- 45 test binaries added with provenance docs
- COM/OLE: CoCreateInstance with registry-based DLL loading
- HLP parser (Windows help files, B+tree + Hall phrase decompression)
- Synchronous WM_CREATE via thunk continuation
- Virtual filesystem
- CBT hook dispatch, complete CREATESTRUCT (MFC window init)
- Multi-timer with real-time intervals
- DialogBoxParamA with continuation-thunk message loop
- Pinball: SetThreadPriority, timeGetTime, post_queue_dequeue

**Apr 3 — the 49-commit day. The biggest single push.**
- CallWindowProcA, EM_STREAMIN RichEdit, Winamp NSIS support
- CreateDIBSection — Winamp installer runs to completion (TreeView visible)
- 8-bit NEG/NOT bug fix (NSIS CRC verification)
- **Pure-JS WAT→WASM compiler** replaces wabt CDN dependency
- **`tools/deploy-berrry.js`** — ships builds with autodiscovery + batched uploads
- Real console screen buffer + 26 console APIs (Telnet)
- Split oversized WAT files into domain-specific modules
- Per-EXE status reports + master analysis for all 45 binaries
- Parity flag, replace magic numbers with named globals
- **Multi-app desktop**: per-app hwnd ranges, route input by hwnd
- Per-window offscreen canvases for overlap rendering
- **Final tally: 23 PASS / 12 FAIL / 10 WARN**

**Apr 4:**
- WASM bulk ops (`memory.copy`/`fill` for REP string ops)
- **Tail calls for threaded dispatch — ~40% faster execution**
- NSIS file extraction
- Pinball: CreateDIBitmap, named resources, z-order input
- 32 PASS

---

## Act IV — "Logic into WAT" (Apr 5–9)

The architectural shift. Up to this point a lot of UI logic — chrome painting, menu state, control parsing, dialog frames — lived in JS. The renderer was getting expensive and inconsistent. Decision: **JS is GDI primitives only; everything else is WAT.**

**Apr 5–6: pinball + NSIS bug bash + control refactor seeds**
- Set_flags_logic missing flag_sign_shift (NSIS `$INSTDIR` resolves)
- Pinball init: `_lread` g2w double-translation, `_hread`, CACA0001 nesting
- DestroyWindow promotion fix (Notepad Find dialog stuck-loop)
- StretchDIBits in Node.js via node-canvas
- **Implement controls as real windows** with HWNDs and WAT-native WndProcs
- TreeView control: WAT-native TVM_* messages (RegEdit passes)
- Win98 Tour, MSPaint NT, WordPad: PASS

**Apr 8 (32 commits): the controls-as-windows refactor lands**
```
STEP 1  Affinity stubs unblock Plus! 95 pinball
STEP 2  Merge CLASS_TABLE + WNDCLASSA_STORE → CLASS_RECORDS
STEP 3  $button_wndproc + $static_wndproc on heap-allocated state
STEP 4  $edit_wndproc on heap-allocated EditState
STEP 5  $wnd_send_message + $create_findreplace_dialog (dormant)
STEP 6  Find-dialog test gate drives WAT EditState end-to-end
STEP 7  Renderer draws find dialog children from WAT-side state
STEP 8  Delete JS find dialog dead code
        Bump MAX_WINDOWS=256 / MAX_CLASSES=64
        Listbox class — full wndproc + click → LBN_SELCHANGE
        Open / Save common dialog: WAT-driven, modal pump via CACA0006
```

**Apr 9 (43 commits): Phase 2 — menus into WAT**
- Migrate Button/Edit/ListBox/ColorGrid paint to WAT wndprocs
- Migrate window title bar / NC paint to WAT defwndproc
- **Phase 2: menu bar paint + parse + tracking state + input routing into WAT**
- Phase 2 finish: drop `win.menu`, kill `parseMenu`, guard nested repaint
- Winamp skin rendering: GetWindowDC split, full-window canvas
- WAT-native Edit control for notepad
- Paint queue: replace single `child_paint_hwnd` with 16-entry queue

By end of Act IV, the JS renderer is *almost* nothing but `getDrawTarget()` + `<canvas>` blits. Window geometry, menu state, control state, dialog frames — all live in WASM linear memory.

---

## Act V — "Make hard things work" (Apr 10–15)

DirectDraw, audio, full skinned UIs, and a final cleanup pass.

**Apr 10:**
- Dialog rendering with controls visible
- Solitaire fully playable (mouse, time progression, drag drop)
- **Move RT_DIALOG parsing entirely into WAT**
- **Finish RT_* migration: kill `lib/resources.js`** (per the "resources in WAT" principle)
- DestroyWindow focus transfer replaces pinball flag-poke hack
- FreeCell regression test
- Menu checkmarks (proper V-glyph)

**Apr 11 (38 commits): screensavers, plus icons-from-PE**
- DLL loader: surface ordinal imports as clear errors
- Drop stock Win98 advapi32/shell32/shlwapi (use real DLLs from each exe instead)
- Browser shell: non-debug UI is just a desktop with app icons
- **Desktop icons: extract real PE icons at runtime** (RT_GROUP_ICON walker)
- WM_DRAWITEM for BS_OWNERDRAW
- **Spider Solitaire fully playable; SW_MAXIMIZE; Solitaire scoring verified**
- Plus! 98 screensavers added; smoke test suite
- FPU: tag word, exception flags, crash on unimplemented
- waveOutSetVolume/GetVolume with real host volume
- DLL loader: msvcrt SBH disable via `__active_heap` patch
- **HLP parser rewrite** with proper TopicLink record parsing

**Apr 12: DDraw + screensavers come alive**
- Screensaver sprite rendering: mono→color expansion, RLE decompression, row stride
- Use `exe_size_of_image` for wndproc validation (was hardcoded 0x80000)
- MFC screensaver WM_CREATE crash fix
- **Marbles: WM_ACTIVATEAPP, DDPalette vtable, 8bpp Present** → renders end-to-end
- DDraw screensaver init, D3D COM stubs
- Pinball Player 1 label, heap realloc, deferred audio, thread scheduling

**Apr 13: COM hardening**
- DDraw QueryInterface: must AddRef (slot-0 reuse bug — that became a durable session-memory rule)
- InSendMessage / EnumWindows
- D3DRM design doc
- PlaySoundA, CreateDIBSection live-mapping, thread-shared GDI
- IDirectDrawFactory (CLSID from ddrawex.dll)
- Calc blank-button-pad fix: resolve NULL DlgProc → class wndproc
- CLSIDFromProgID, code review report
- Resource leaks, decoder gaps, **synchronous SendMessage**
- shell_execute host bridge
- WaitForMultipleObjects + shared memory sync table

**Apr 14:**
- Shared-memory binary emitter, **true sleep (Atomics.wait)**, recursive window destruction
- **GDI/Renderer: SetWindowRgn + non-rect clipping** (skinned UIs)
- D3DIM Phase 0 + 0.5: stub vtables + device state round-trip
- CRT unblocks: IsBadCodePtr, timeGetDevCaps; MCM reaches KVDD.DLL video init (700+ API calls deep)
- Heap OOM guard, GetKeyboardType, GetTextCharacterExtra
- **GDI viewport origin: real per-DC state**
- EmPipe (Pipe Dream) added
- Winamp: separate modal pump hwnd from `$dlg_hwnd`

**Apr 15 (19 commits): the unification pass**
- Walk child→parent for DC routing, grow paint queue, extend GDI tracing
- Per-window WASM for menu ops in multi-app mode
- **Route child WM_PAINT to parent's back-canvas** + add `--trace-dc`
- **Route ncpaint + menubar to back-canvas** — unify surfaces
- **Remove `_drawWatChildren`** — let the message loop paint children
- Class atoms: preserve MAKEINTATOM names
- **Drop JS chrome fallback**, sync CONTROL_GEOM on MoveWindow/SetWindowPos
- Route menu dropdown paint to dedicated overlay canvas
- SetTextAlign/GetTextAlign real impls; BeginPaint erases inline
- `$invalidate_hwnd` so WM_CHAR dispatches WM_PAINT
- **WAT-native dialog defaults** + clipboard/DX scaffolding
- Drop legacy JS edit-control input fallbacks
- **BltFast 8bpp SRCCOLORKEY** + `--trace-dx` with DX object decoding
- **Fix modal dialog rendering**: paint pump + bkgnd fill + parent link
- Move wheel + Edit-menu clipboard ops to WAT
- Move dialog child mouse routing into WAT
- Winamp: reinstate deferred WHDR_DONE for streaming playback
- **Delete dead JS edit paint path** ← latest commit

---

## Act VI — "Make the platform real" (Apr 16–21)

The post-foundation push. Act V finished JS-side cleanup; Act VI is when the harder Win32 surface — message routing, dialog modality, real D3D rasterization — gets serious.

**Apr 16 (48 commits): the biggest single day since Apr 3.**
- **Memory layout relocated +32MB** — DX_OBJECTS/COM_WRAPPERS moved to high memory (0x7FF0000); g2w bounds expanded; FLASH_TABLE addr fixed.
- **Comprehensive x86 operand-size audit**: 31 new handlers; 8/16-bit ALU precision fixes; 0x66 prefix coverage on XCHG/TEST/CMPXCHG/XADD.
- **Message-queue routing Phases 0-7**: non-client messages, titlebar buttons, focus, ShowWindow, WM_SETCURSOR — everything that used to fire synchronously now goes through the queue.
- AoE enters its main loop (MapViewOfFile, 128MB memory).
- Auto-generate COM vtable init from `api_table.json` — adding a new interface no longer requires manual ID fixups.
- W95FA + Fixedsys Excelsior fonts bundled for the Win98 look.
- TreeView renderer; FlashWindow with real per-window state; ncpaint reuses whole-window DC.
- File reorg: per-binary notes → `apps/`, design docs → `docs/`, scratch → `scratch/`.
- Memory-map documentation (`docs/memory-map.md`).

**Apr 17–18:**
- Decoder: `emit_sib_or_abs` hoisted before `te()` in 26 memory-operand sites — fixes a recurring class of "data-address as 2nd opcode arg" bugs.
- Solitaire activation chain restored after the memory relocation regression.
- MCM: `LoadStringA` ignored hInstance — strings live in `lang.dll`. Per-module resource lookup honors hInstance now.
- `InstallType=Full` registry seed makes MCM's CD-check pass.

**Apr 19 (35 commits): D3DIM gets real.**
- **8bpp surface GDI round-trip via palette export** — guest GDI calls on DDraw surface DCs route to per-slot canvas with DIB sync.
- D3DIM: viewports bind to device on AddViewport/SetCurrentViewport; real `IDirect3DLight` Set/GetLight state.
- DDraw GetCaps fills `dwVidMemTotal/Free` and `dwZBufferBitDepths`; reports `DDCAPS_3D` so MCM passes its 3D gate.
- **Aux COM wrappers** so QI on a child surface returns a fresh slot, not the parent's.
- INI reads fall back to VFS file when no localStorage override — `.scn`/`.ini` assets "just work".
- DirectDrawCreateClipper, EnumDisplayModes continuation.
- Plus!98 Organic Art `DefaultScene=Architecture` registry seed.

**Apr 20 (48 commits): rasterizer + chrome polish.**
- **D3DIM flat triangle rasterizer** with back-face culling per `D3DRENDERSTATE_CULLMODE`.
- **85× faster `SetDIBitsToDevice`** hot path; PROF_SDI instrumentation.
- IDirectDrawSurface2 vtable (GetDDInterface, PageLock, PageUnlock).
- Default 8bpp palette installed at SetDisplayMode.
- Chrome: scrollbar arrow buttons with pressed state, listbox WS_VSCROLL strip, page-up/down on track, thumb drag via generalized capture.
- Title-bar sysbuttons get pressed visuals.
- **Real `ExcludeClipRect`/`IntersectClipRect`** — chain-of-Path2D HRGN.
- Modal CACA0006 pump drains nc_flags + paint queue.
- XLAT (0xD7).
- Test harness: pixel-diversity gate, two-signal blank detection.

**Apr 21:**
- DirectX SDK Samples added to launcher; `ddex3`/`ddex5` unblocked.
- DDraw QI(DDRAW2) must not upgrade vtable in-place; primary-surface creation resizes main window.
- BltFast / Blt / ColorFill trace categories.
- `bsearch` with CACA000C continuation; `exit/_exit` halts the loop.
- `tools/find_field.js` — scan .text for `[reg+disp]` accesses.
- Menu dropdown bypasses window clipRgn when painting to overlay.

---

## Act VII — "The long tail" (Apr 22–28)

Now everything below the main daily-drivers gets its own session: comboboxes, dialog chrome, screensaver investigations, the Plus!98 Organic Art chain, audio decode, focus traversal. The tooling story compounds — `--trace-stack`, `--count`, `module+0xVA` syntax, typed API args/returns, `caller_census.js`, `find_vtable_calls.js`.

**Apr 22:**
- **Notepad's full dialog suite renders** — About (chrome+title+version), Find, Open/Save, Font, Color all paint correctly with title bars.
- DX QI must upgrade vtable for Surface↔Texture roundtrips.
- `tools/find_string.js` + `tools/file2va.js` — string-driven xref hunts.
- `--trace-api-counts`: end-of-run histogram.
- SearchPath long→8.3 fallback (Plus!98 screensaver meshes).
- SEH EH3 frame_ebp = `seh_rec+0x10` (was +0xC).
- DXException identified as app-internal; Edit WM_KILLFOCUS on click + drag-select capture.

**Apr 23:**
- DDraw `Blt` does nearest-neighbor stretch when src/dst rects differ — fixes WIN98.SCR doubled-logo / black-bottom-half.
- Per-hwnd back-canvas pre-filled opaque black so `GetDC(desktop)→BitBlt` captures aren't transparent.
- SystemMetrics CX/CYSCREEN driven from host canvas size.
- MSPaint: deep-hit-test input routing + always-on child clipping.
- D3DIM viewport `dwHeight` stored; V3 Set/GetViewport stubs.

**Apr 24 (23 commits): D3DIM Execute ops land.**
- **Real matrix handle table + STATETRANSFORM dispatch** (`feat(d3dim): real matrix handle table + STATETRANSFORM dispatch`).
- Execute ops POINT, LINE, MATRIXLOAD, MATRIXMULTIPLY, **PROCESSVERTICES**, BRANCHFORWARD, SETSTATUS.
- Polyline = MoveTo + LineTo chain.
- `RegDeleteKey{A,W}`, `RegDeleteValue{A,W}`.
- Window resize edges; min/max gate on style; gray disabled glyph.
- SendMessage preserves caller GP regs across sync x86 wndproc dispatch.
- `--trace-dx-raw`, `--thread-slices=N`, final thread dump.

**Apr 25:**
- **TileWorld boots end-to-end** via real semaphores (SDL 1.x).
- **Per-thread thread-cache partition** at 0x80000 — fixes TWorld picker wedge where main+T1 caches collided.
- BitBlt silent-clips dst to back-canvas (saves Winamp T4).
- VirtualQuery, VkKeyScanW, MapVirtualKeyW, ShowOwnedPopups.

**Apr 26 (56 commits): the trace + plumbing megaday.**
- **Typed API trace**: args/returns via `args:[{name,type[,out:true]}]` in `api_table.json`; out-params decoded post-handler; `--trace-stack`, filter, `--trace-api-dedup`.
- `--trace-callstack=N` (shadow ret-addr stack via CALL/RET hooks); `--trace-wave`, `--trace-thread`, `--trace-yield`, `--audio-stats`, `--break-thread`; multi-addr `--watch`/`--trace-at`.
- **Real modal `MessageBoxA` dialog** + CACA0006 auto-pop fix.
- **Paint queue replaced with per-WND flag table** (Win32-style).
- Dialog focus traversal — Tab/Shift+Tab/Enter/Space; pixel-stipple focus rect; BM_SETCHECK enforces radio mutex on BS_AUTORADIOBUTTON.
- **FPU**: FLDENV/FNSTENV/FRSTOR/FNSAVE/FBLD/FBSTP.
- Per-thread hwnd allocator partition; bp/watchpoint propagation to worker WASM instances.
- `tools/dump_va.js`, `tools/vtable_dump.js`.
- Calc: erase static rect on repaint + grey back-canvas pre-fill; WS_EX_CLIENTEDGE statics paint as white sunken frames.
- `route gdi_bitblt + gdi_stretch_blt through _drawWithClip`; descendants always clipped regardless of zOrder.

**Apr 27 (45 commits): comboboxes + double-translation cluster.**
- **Combobox real dropdown state machine** + listbox delegation; CBS_DROPDOWN edit child + EM_SETLIMITTEXT; CB/LB GETITEMDATA + SETITEMDATA.
- **WS_POPUP shell substrate** for dropdown windows; combo_popup_wndproc (class 9); listbox migrates under shell on dropdown open.
- One dropdown open at a time; close on outside click / Tab / single-click accept.
- Dialog scope of modal pump nc_flags drain; style + title propagate onto dialog hwnd.
- **Double-translation fix cluster**: `wsprintfW` args, `GetFileVersionInfo*`/`VerQueryValue`, SEH C++ FuncInfo/TryBlockMap, `CompareString A/W` cchCount2 offset, DDBLTFX.dwFillColor at +80, `_XcptFilter` cdecl stub leaked retaddr/args.
- WAT bool coercion in `i32.and`; CBT hook fires for child CreateWindowEx.
- Listbox skips WM_PAINT when WS_VISIBLE is off; word-wrap statics; combobox stub.

**Apr 28 (23 commits):**
- **Maximize/restore**: post WM_MOVE+WM_SIZE on SC_MAXIMIZE/SC_RESTORE; toggle SC_MAXIMIZE↔SC_RESTORE on second click; redraw chrome after resize-driven back-canvas realloc; suppress edge-resize while maximized; flat (not 3D-bevel) maximize/restore glyphs.
- **Decoder: centralize segment-override** + trap 0x67/GS — exposes apps that need real fs/gs handling rather than silent reinterpretation.
- Pinball Player Controls dialog: combobox dropdown — POST notifications + popup zorder + popup-shell click forwarding; keyboard fix populates the dialog correctly.
- Walk children by parent linkage when seeding paint flags.
- `tools/find_vtable_calls.js` (scan PE for `call dword [reg+disp]` by slot); `tools/caller_census.js` (per-callsite hit counts via `--count`); `module+0xVA` syntax in `--break`/`--count`/`--trace-at`.
- Pinball: ball_count theory corrected; the then-current bug was a Z-only flipper, resolved in Act VIII.
- `deploy-berrry`: skip non-desktop binary dirs.

---

## Act VIII — "From demo to daily use" (Apr 29–May 6)

The next 151 commits turned several convincing demos into applications that
could survive real input, repaint, and audio workflows.

**Apr 29–30:**

- Pinball's apparent physics bug was traced through its real message pump.
  Posted `WM_USER` traffic could starve hardware input, so Peek/GetMessage now
  polls host input without the old app-specific state poke. The web build then
  ran interactively with moving flippers.
- RCT recovered its first frame and progressed into its runtime path after
  address-size `LOOP` handling and DirectDraw fixes.
- Dynamic `LoadLibraryA` began calling guest `DllMain`; that was essential for
  `d3dxof.dll` template registration and deeper D3DRM parsing.
- The paint path gained region-driven invalidation and an HDC table. A failed
  intermediate paint phase was diagnosed, reverted, rebuilt with its missing
  prerequisites, and landed again—the session history records why “debug the
  phase, don't discard the architecture” became a project rule.
- Node rendering moved from node-canvas to skia-canvas so CLI/browser clipping
  shared a more capable Canvas implementation.

**May 1–6:**

- Generic MIDI arrived through MCI/midiOut behavior and a vendored TinySynth
  Web Audio backend. Pinball gained real music and sound instead of a
  Pinball-specific playback shortcut.
- Fullscreen timing/scaling, message boxes, owner-draw states, mouse capture,
  Notepad editing/caret/find flows, and modeless dialogs were hardened through
  browser-visible regressions.
- The Winamp NSIS installers became genuinely interactive: license RichEdit,
  scrollbars, common controls, child clipping/order, progress bar, and real
  click-driven test coverage.
- DC clipping and paint ownership moved into WAT. Edit caret blinking followed
  it into WAT timers.
- The debug toolbar gained active-window video plus audio recording, cropped to
  the emulated window and captured at 2x nearest-neighbor resolution.

---

## Act IX — "Ship the browser, then tune the hard app" (May 7–29)

The browser shell became a product while Winamp became the long-running
multithreaded stress test.

**May 7–15:**

- RCT web assets, generated-code invalidation fixes, a 32MB decoded-thread
  cache, and DirectDraw presentation brought the shareware build to a visible
  browser path.
- A Safari-compatible dispatch build, touch input, viewport-aware canvas
  scaling, PWA metadata, and a hidden mobile keyboard proxy made the desktop
  usable on iPhone/iPad.
- Funtris, Pyramid, EmPipe, Winamp, application cursors, wide-string APIs,
  scrollbar thumbs, common dialog paths, and persistent registry state all got
  focused interaction tests.
- Idle `GetMessage` began blocking correctly. Cascading menu state and drawing
  moved fully into WAT, and app-specific run-loop fast paths were removed.
- The public launch added the Product Hunt badge and MIT license. Claude
  session notes explicitly corrected the project's wording from
  “hand-written” to “coded directly in WAT” so the AI collaboration was not
  erased.

**May 21–29:**

- Winamp plug-in fixtures, preferences, visualizer menus/restart, popup menus,
  audio scheduling, skinned moves, and memory-region overlap bugs were worked
  through as one system.
- New profiling separated decode/output scheduling, audio gaps, visualizer
  frame rate, restart behavior, quality modes, and candidate
  superinstructions. The key result was diagnostic: low visualizer FPS was
  mostly guest render cost, not Canvas or Web Audio.
- AoE's menu became visible and clickable after palette-cache invalidation and
  fullscreen coordinate mapping.

---

## Act X — "Broaden the machine" (Jun 1–18)

June split in two: understand why AoE was slow, and fill enough Direct3D and
Win32 breadth that many more real binaries could render meaningful frames.

**AoE and the interpreter:**

- Sparse virtual-memory backing and x86-correct overlapping REP behavior got
  AoE through campaign loading and into an in-game map.
- Repeatable Chrome and headless profilers measured launch and gameplay
  separately. Handler histograms, hot-block reports, SIB/branch operand
  profiles, liveness estimates, block-shape censuses, and compiler-printer
  tools replaced guesswork with workload data.
- Specialized hot threaded handlers helped, while several proposed branch
  fusions did not. The surviving design is a generic block/trace compiler that
  reduces register and flag traffic without embedding AoE algorithms.
- A later Codex continuation measured the isolated compiled-block proof of
  concept at roughly 1.039x less browser guest time and 1.059x more presented
  frames over a 20-second gameplay window. It remains experimental and was not
  merged into the main interpreter.

**Compatibility and 3D:**

- D3DIM gained projection state, indexed geometry, eye-plane clipping, depth
  testing, matrix refresh, render-target binding, D3D3 vertex buffers/FVF
  paths, and a broad D3D7 device/state/caps surface.
- DX5 samples, Globe, Organic Art, MCM, MW3, Abe, AoE/AoE2, RCT, Paint,
  RegEdit, WordPad, Media Player, Sound Recorder, Volume Control, and several
  screensavers received realistic per-target smoke budgets and documented
  startup/frame gates.
- DirectAnimation shims let MFC screensavers advance without pretending the
  full DirectAnimation runtime existed.
- Renderer smoothing was disabled for emulated canvases after a FreeCell win
  exposed bilinear scaling on card art.

---

## Act XI — "Native RichEdit becomes the next platform test" (Jul 6–30)

July had fewer commits, but it changed the next major target.

- Safari compatibility slices were bounded after Private Browsing exposed
  extreme Wasm slowdown; the measured behavior and user workaround were
  documented instead of misdiagnosing Spider and EmPipe as emulator hangs.
- Window/client geometry regressions across Snake, TicTactics, Minesweeper,
  EmPipe, and Winamp were repaired.
- WordPad's lazy `riched20.dll` startup, text input diagnostics, and native
  RichEdit painting were brought up far enough to type and display real text.
- The RichEdit compatibility design deliberately split a bounded,
  app-useful subset from later tables/images/OLE, complex scripts, TOM, and
  exact undocumented version quirks. That boundary let August proceed in
  testable slices.
- D3DIM matrix/culling regressions and Winamp About tab rendering were fixed,
  and the web launcher/recording defaults were refreshed.

---

## Act XII — "Applications become workflows" (Aug 1–12)

August's 152 commits moved the definition of success from “a recognizable
window” to multi-step user workflows.

**WordPad / RichEdit / OLE:**

- Native RichEdit gained navigation/editing, selection and caret rendering,
  mouse/wheel/scrollbar behavior, undo/find/replace, plain-text plus RTF
  clipboard, file New/Open/Save As, formatting accelerators/toolbars/dialogs,
  mixed sizes, paragraph state, advanced RTF fixtures, large-document layout,
  international input, and print/preview lifecycle coverage.
- WordPad's bounded everyday non-OLE target is now functional. Static `CF_DIB`
  objects can be pasted, rendered, copied/cut/pasted, undone, saved in RTF, and
  reopened. General activated/linked OLE servers remain outside that boundary.
- A reusable in-memory OLE layer now includes `ILockBytes`, shared/cloned
  `IStream`, nested `IStorage`, rename/delete/copy/move, snapshot enumeration,
  commit/revert transactions, region locks, `STATSTG` metadata, data objects,
  and clipboard ownership. The focused storage/stream suite reached 68/68 at
  HEAD; current work continues into deterministic compound-file byte
  serialization and fresh-process revalidation.
- Suspended thread creation/resume was implemented and verified against
  WordPad's real startup path rather than bypassed.

**Paint and deterministic GDI:**

- Win98 Paint now has focused coverage for all 16 tools, menus, BMP
  save/open/save, dirty-document prompts, 900x700 scrolling, wide Safari
  layouts, flood fill, and browser airbrush behavior.
- Direct guest DIB updates gained dirty-page tracking and canonical surface
  access. Rectangle/ellipse/polygon regions and application DC clipping moved
  into WAT.
- Canvas antialiasing and the incorrect brush-options glyph grid exposed the
  next architectural limit. A staged software-GDI design now makes native
  pixels authoritative, keeps Canvas for text/composition, and migrates exact
  integer rasterization into WAT. The current worktree includes the first
  one-pixel DIB `LineTo`/ROP2 path; wider pens, shapes, blits, and window
  surfaces still use compatibility paths.

**The Win98 desktop as a system:**

- RegEdit gained registry metadata/value enumeration, hierarchical TreeView,
  bounded report ListView/header behavior, double-click expansion, and a real
  status-bar workflow.
- Sound Recorder gained real browser microphone capture into guest `waveIn`
  buffers and playback. Volume Control now changes shared master, Wave, and
  MIDI buses across applications.
- Task Manager now enumerates independent emulator instances and can Switch
  To, End Task, minimize, cascade, tile, and arrange the real shared desktop.
- Media Player was exercised in both native-DLL and compatibility-fallback
  modes; common controls, mixer state, ListView image lists, toolbars, and
  cross-app focus all became reusable platform features.

The latest recorded complete smoke run on Aug 12 covered 114 binaries: 81
PASS, 29 WARN/known-limited, 4 expected 16-bit NE skips, and zero unexpected
FAIL entries. That remains a startup/frame matrix, not a claim that all 81 are
feature-complete; the focused workflow suites are the stronger evidence.

---

## Act XIII — "Everything the host still knew moves into WAT" (Aug 13–19)

632 commits in seven days — 30% of the project's history — and the theme is a
single one: every remaining place where JavaScript still *understood* something
about Windows was closed, and the platform grew a second CPU mode underneath it.

**GDI stops being a Canvas wrapper.** The staged software-GDI plan from Act XII
was carried to its end. WAT took ownership of DC state, pixel formats, bitmaps,
palettes, brushes, pattern sampling, DIB transfers, clipping, path state,
metafile record and replay, printer pages, and monochrome/mask blits. The legacy
JavaScript GDI state was deleted outright, and the browser and CLI both compose
through one canonical surface contract rather than a 2D context. `lib/apps.js`
and `lib/raster-canvas.js` mean the CLI has no native canvas dependency at all
now: the same rasterizer produces the headless PNGs and the browser pixels.

**Fonts became a subsystem, and Canvas text was deleted.** A design doc
("scalable-font-design.md") preceded the code, which is the pattern that keeps
working. WAT now parses TrueType — `glyf` outlines, composites, kerning, ABC
widths, `TEXTMETRIC` derivation, CP1252 mapping — flattens contours, scan-converts
glyphs, caches faces and strikes, and lays out runs. Bitmap `.FON` strikes were
generated for the Win9x stock faces, vendored under open licences, and mounted by
both hosts through one substitution manifest. Then `eff03cb` — *"Delete the
JavaScript text path"* — removed the fallback. Text is now measured the way
Windows 98 measured it, one advance at a time, against metrics captured from a
real Win98 box.

**WinHelp became a real viewer.** The `.hlp` format (B+trees, Hall phrase
decompression, topic/context/keyword indexes, CNT hierarchies, fonts, bitmaps,
hotspots, macros, secondary windows, tables) was implemented in WAT across four
new parts, the semantic JavaScript runtime was removed, and the Windows 98 Help
viewer itself runs. Every app now ships its help file to the browser.

**The virtual LAN.** Winsock moved into WAT with a socket table and an in-process
switch, and a `vln/1` frame wire joins two emulator processes — or two browser
tabs — into one room. Liquid War completes a real connection driven from its own
Net menu; two Hearts processes deal and play a full hand across the wire, which
forced DDEML to become real (wildconnect, advise loops, pokes, executes, busy,
timeouts). All routing lives in WAT; the transport carries opaque frames.

**16-bit Windows.** The oldest entry on the "explicit limits" list fell. An NE
loader links segments and fixups, ordinal imports resolve against a generated
`win16-ordinals` table, 16-bit segment/addressing ops joined the decoder, tasks
get DGROUP-relative local heaps with a free list, and a Win16 API layer
(~9k lines, plus dialogs and DDEML) carries tasks into their own `WinMain`,
message loops, menus, dialogs and resources. The original 16-bit Entertainment
Pack now runs in the browser next to its 32-bit remake, and even the Visual Basic
1.0 titles get as far as their own forms.

**Then the tree got a review it could not argue with.** On Aug 18 four parallel
deep reviews produced `fable-review.md`: the macro-architecture is sound; the
problems are *drift*. Files whose names had stopped describing their contents
(a 17k-line "helpers" file that was 74% GDI), parallel hand-copies that had
silently diverged (A/W pairs, browser-vs-CLI host paths, ~24 copied PE parsers),
and invariants kept in sync by discipline rather than by the build. The week
closed by fixing all three classes: GDI, OLE, the window table, comctl32 and the
Win16 layer moved into files named for them; every A/W pair became one body;
`lib/pe.js` became the one PE reader; the browser launcher, app registry, input
bridge and DLL walk left `index.html` for `lib/`; and the build gained gates for
the manifest, the generated tables, handler counts, stdcall epilogues, and
unresolved function names — the last of which had been silently building calls
that did nothing.

Around all of it: the corpus grew a screenshot-based sweep that pulls every lever
on every app's menus, 145 tests that had been written but never wired up were put
under a gate, and a perf HUD learned to separate *game* fps from *page* fps so
"it feels laggy" became a measurable claim.

---

## 2. Architecture today

```
┌────────────────────── Browser / Node ──────────────────────┐
│                                                            │
│  index.html / test/run.js                                  │
│       │                                                    │
│       ▼                                                    │
│  ┌────────────┐   GDI / audio / file / registry imports    │
│  │ JS host    │◄──────────────────────────────┐            │
│  │ lib/*.js   │   ↑ browser/Node boundary:    │            │
│  └─────┬──────┘     • canvas/pixel upload     │            │
│        │ instantiate• audio/input             │            │
│        ▼            • async I/O bridges       │            │
│  ┌──────────────────── WASM module ───────────┴────────┐   │
│  │                                                     │   │
│  │  PE loader → x86 decoder → threaded code cache      │   │
│  │       ▲             │                               │   │
│  │       │             ▼                               │   │
│  │       │       ┌──────────────┐                      │   │
│  │       │       │ $next loop   │── tail call ────┐    │   │
│  │       │       │ (call_indir.)│                 │    │   │
│  │       │       └──────────────┘                 ▼    │   │
│  │       │                                  ALU/FPU/   │   │
│  │       │                                  string ops │   │
│  │       │                                  Win32 API  │   │
│  │       │                                  handlers   │   │
│  │       │                                  WAT wndprocs│   │
│  │       │                                  WAT menus  │   │
│  │       │                                  WAT dialogs│   │
│  │       │                                  COM / OLE  │   │
│  │       └─── thunk EIP → $win32_dispatch ◄────────────┘   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**Source layout (concatenation order = filename alphabetical):**
```
src/
├─ 01-header.wat               ┐
├─ 01b-api-hashes.generated.wat│  PE / CPU plumbing
├─ 02-thread-table.wat         │
├─ 03-registers.wat            │
├─ 04-cache.wat                │
├─ 05-alu.wat                  │  x86 core
├─ 05b-string-ops.wat          │
├─ 06-fpu.wat                  │
├─ 07-decoder.wat              ┘
├─ 08-pe-loader.wat            ┐  loaders
├─ 08b-dll-loader.wat          ┘
├─ 09a-handlers.wat            ┐
├─ 09a2-handlers-console.wat   │
├─ 09a3-handlers-audio.wat     │
├─ 09a4-handlers-gdi.wat       │  Win32 API surface
├─ 09a5-handlers-window.wat    │  (broken out by area)
├─ 09a6-handlers-crt.wat       │
├─ 09a7-handlers-dispatch.wat  │
├─ 09a7b-ole.wat               │
├─ 09a7c-mixer.wat             │
├─ 09a8-handlers-directx.wat   │
├─ 09a9-comctl32.wat           │
├─ 09aa-handlers-d3dim.wat     │
├─ 09ab-handlers-d3dim-core.wat┘
├─ 09b-dispatch.wat            ┐
├─ 09b2-dispatch-table.generated.wat
│                              │  dispatch + window mgr
├─ 09c-help.wat                │
├─ 09c0-window-table.wat       │
├─ 09c2-treeview.wat           │
├─ 09c3-controls.wat           │
├─ 09c4-defwndproc.wat         │
├─ 09c5-menu.wat               ┘
├─ 09c6-winhelp-core.wat       ┐
├─ 09c7-winhelp-hlp.wat        │  WinHelp engine (Act XIII)
├─ 09c8-winhelp-cnt.wat        │
├─ 09c9-winhelp-ui.wat         ┘
├─ 09d-winsock.wat             ─  virtual LAN
├─ 09e-win16-api.wat           ┐
├─ 09e2-win16-dialog.wat       │  Win16 personality
├─ 09f-win16-ddeml.wat         ┘
├─ 10-helpers.wat              ┐
├─ 10a-gdi-bitmap.wat          │
├─ 10b-gdi-font.wat            │
├─ 10c-truetype.wat            │  GDI, now in files
├─ 10d-gdi-region-path.wat     │  named for what it is
├─ 10e-gdi-metafile.wat        │
├─ 10f-gdi-dc.wat              │
├─ 10g-gdi-raster.wat          ┘
├─ 11-seh.wat
├─ 12-wsprintf.wat
└─ 13-exports.wat
```

The 16-bit path enters at `08c-ne-loader.wat` with `05c-seg16-ops.wat` under it,
and everything above the loader — windows, menus, dialogs, GDI — is shared with
the 32-bit side.

**Rendering/composition baseline (Apr 15 unification, still active):**
```
guest GDI calls
       │
       ▼
   _getDrawTarget(hdc)          ← --trace-dc shows resolution
       │
       ▼
┌─ per-hwnd back-canvas ─┐      one offscreen canvas per
│  (sized to full window)│      top-level hwnd
│                        │
│  guest draws + child   │      child WM_PAINT, ncpaint,
│  WM_PAINT both land    │      menubar all composite here
│  here in window-local  │
│  coords                │
└────────────┬───────────┘
             │
             ▼  repaint() z-order blit
       screen canvas (composite target only)
```

The August software-GDI migration adds a second, transitional layer beneath
that compositor. DIB-backed memory DCs can resolve to native-format canonical
pixel storage; WAT-owned regions/clips and selected exact raster operations
write those pixels, then JavaScript uploads only dirty rectangles. Canvas is
still the compatibility path for remaining primitives and the intentional
text backend, while per-window canvases remain the desktop composition target.

---

## 3. What runs

| Tier | App/workflow | Current evidence |
|---|---|---|
| Core desktop | Notepad, Calculator, Solitaire, Spider, FreeCell, Minesweeper, SkiFree, Entertainment Pack games | Focused editing/gameplay/rendering tests; the mature daily-driver set |
| Rich document | WordPad | Functional bounded non-OLE editing/formatting/files/printing plus static DIB OLE objects; general activated/linked objects and current-tip two-image revalidation remain |
| Paint | MS Paint Win98 | All 16 tools, BMP workflows, dirty prompts, large scrolling, and browser regressions; option glyphs and exact non-antialiased pixels remain |
| Registry/shell | RegEdit and Task Manager | Stateful TreeView/ListView/registry workflows; Task Manager operates on real independent desktop app instances |
| Audio | Sound Recorder, Volume Control, Winamp 2.91 | Real microphone capture/playback, cross-app Wave/MIDI gain buses, skinned MP3 playback and visualization |
| Installers | Winamp 2.91/2.95 NSIS | Silent and interactive flows extract expected files, exercise RichEdit/progress controls, and finish cleanly |
| DirectDraw/D3D | Marbles, DX5 samples, Organic Art | Meaningful 2D/3D frames with real execute buffers, transforms, clipping, depth, and broad D3D3/D3D7 state |
| Heavy demos | AoE, AoE2, Abe, MCM, MW3, RCT | Promoted startup/frame smokes; AoE also has a scripted route into the map. These are not claimed as complete games |
| Web shell | Multi-app desktop/PWA | PE icons, touch/mobile keyboard, Safari compatibility build, cross-app focus/audio/window management, and active-window recording |
| 16-bit | Windows Entertainment Pack 1–4, Hearts, Chess, Klotski, Pipe Dream | NE images load/link/run with real menus, dialogs, resources and help; all 31 launch and most draw their game |
| Help | Windows 98 Help viewer plus each app's own `.hlp` | WAT-native `.hlp`/`.cnt` parsing, topics, keyword index, hotspots, macros, secondary windows |
| Networked | Liquid War, Hearts, TetriNET | Real connections over the virtual LAN — two emulator processes, or two browser tabs, playing each other |
| Explicit limits | VB6/DX9 targets, DirectAnimation, full IE/Winamp minibrowser | Unsupported or bounded honestly rather than hidden behind silent success |

The latest recorded full matrix is 106 PASS / 0 FAIL across the corpus, and the
four entries that used to be "expected 16-bit NE skips" now run. “PASS” there
means the configured startup/frame gate; only focused tests justify the stronger
workflow claims in the table. A separate menu sweep pulls every command on every
app's menus and reports what each one actually did.

---

## 4. Patterns that emerged

The repository guidance, Claude memory files, and later Codex sessions capture
the lessons. The big ones:

```
Fail-fast stubs       crash_unimplemented, never silent return-0.
                      Crashes give you the next API to implement; silent stubs
                      give you a bug days later in unrelated code.

Compositions in WAT   Controls = wndproc compositions. JS exposes GDI primitives.
                      No draw_button-style imports.

All logic in WAT      JS only does GDI→canvas mapping. Window state, dialog
                      frames, hit-test, message routing — all live in WAT.

Resources in WAT      PE resource parsing belongs in WAT for all RT_* types.
                      lib/resources.js was tech debt — deleted Apr 10.

COM QI must AddRef    QueryInterface handlers must AddRef even when returning
                      same "this"; otherwise Release frees the slot.

Handlers must pop ESP Every $handle_* must `esp += 4 + nargs*4`. Drift causes
                      wild jumps later — silent corruption, hours of debugging.

Verify runtime EIP    Disasm at a call site can lie; confirm the runtime path
                      via prev_eip instrumentation before trusting "obvious"
                      disasm.

WAT i32.and is bitwise Never bitwise-AND a raw pointer with a 0/1 boolean;
                       coerce to 0/1 first. (Many bugs.)

No silent stubs       (yes, said it twice — that's how important it is)

Tracing > console.log Add a --trace-X category to host-imports.js, not a
                       console.log to source. Source stays clean between
                       sessions; tracing is a runtime flag.

Bounded evidence       A smoke PASS proves only its configured startup/frame
                       gate. Claim a workflow only when a focused test drives it.

Preserve live work     Never stash/reset away another session's changes; use
                       explicit paths and isolated worktrees for experiments.

Direct in WAT          “Coded directly in WAT” describes the implementation.
                       It does not erase the Claude Code/Codex collaboration.
```

---

## 5. Tooling that paid off

```
tools/build.sh              Validate + concat src/*.wat alphabetically;
                            compile tail-call and compatibility WASM via watjs
tools/gen_dispatch.js       api_table.json → 09b2-dispatch-table.generated.wat
tools/gen_api_table.js      FNV-1a hash table for API name→ID
tools/disasm.js             x86 disasm (importable; used by tracing too)
tools/hexdump.js            Memory hexdump
tools/parse-rsrc.js         PE resource section parser
tools/pe-imports.js         PE import table dumper (--all, --dll=NAME)
tools/pe-sections.js        PE section header dumper
tools/render-png.js         Headless PNG renderer
tools/check-parens.js       WAT paren balance checker
tools/find-refs.js          Reference finder (data-VA pointer literals)
tools/find_field.js         ModRM [reg+disp] scanner (struct field accesses)
tools/find_string.js        String→VA hunt; pair with xrefs.js
tools/file2va.js            File offset ↔ VA conversion
tools/find_fn.js            Walk back from interior VA to fn entry
tools/find_vtable_calls.js  Locate `call dword [reg+disp]` by slot/disp
tools/dump_va.js            Static PE byte peek (BSS-aware)
tools/vtable_dump.js        Dump fn-pointer slots + first instr per slot
tools/caller_census.js      Per-callsite hit counts via --count
tools/disasm_fn.js          Disasm at VA(s); warns on mid-instruction starts
tools/xrefs.js              Find branches/loads/stores referencing a VA
tools/profile-aoe-web.js    Browser launch/gameplay CPU and frame profiler
tools/profile-winamp-web.js Decode/audio/visualizer scheduling profiler
tools/deploy-berrry.js      Ship to berrry.app with sha256-diff incremental
                            uploads (Apr 11)
test/run.js                 Headless emulator with rich --trace flags +
                            module+0xVA syntax + typed --trace-api
test/test-all-exes.js       Smoke test suite — pixel-diversity gate +
                            two-signal blank detection; per-exe budgets
```

The `--trace-*` family in particular pays compounding interest. Every time someone added a new category instead of a one-off `console.log`, future investigations got faster.

---

## 6. The numbers

```
Lines of WAT           149,989     (54 files in src/)
Lines of JS support    122,630     (lib/ + test/ + tools/)
WASM builds             ~765 KB    (tail-call and compatibility variants)
Commits                 2,131
Calendar span           147 days   (Mar 26 through Aug 19, inclusive)
Active commit days      90
Avg / active day        ~23.7 commits
Peak day                154 commits (Aug 14)
Last seven days         632 commits (30% of all history)
Focused test files      365 in test/
Smoke matrix            114 binaries; last full run 106 PASS / 0 FAIL, and the
                        4 former 16-bit NE skips now run
Per-app investigations  36 *.md files in apps/
History sources         Git + Claude project history/memory (24 sessions since
                        Aug 12 alone) + 72 repo-tagged Codex rollout transcripts
                        + 1,549 messageboard entries
```

---

## 7. What's in flight right now

1. **Win16 breadth** — NE images load, link and run, and the 16-bit Entertainment Pack plays; the tail is per-app (Visual Basic 1.0 forms, DOS-era CRT assumptions, 16-bit GDI corner cases) rather than structural ([status](TODOS.md)).
2. **Real threads in the browser** — a probe took the pipeline all the way from WAT to WASM workers to canvas, and answered the gating question: production is not cross-origin-isolated today but has a route there. Single-threaded stays a permanent supported mode ([design](docs/design-real-threads.md)).
3. **Finishing the de-drift pass** — `fable-review.md` is largely worked off, and the remaining items are the ones that need design rather than a move: the residual "dispatch" bucket files, the hottest interpreter paths (per-block scan tax, generic re-dispatch of decode-time constants), and the browser drive loop's composite-per-step.
4. **OLE persistence and WordPad revalidation** — the in-memory storage/stream contract is broad and green. Finish deterministic compound-file serialization/reading, then re-run bounded fresh-process static-image save/delete/reopen pixels on the settled GDI path ([plan](docs/non-gdi-work-plan.md), [status](apps/wordpad.md)).
5. **Generic threaded/block compilation** — AoE profiling identified register/flag/EA reuse opportunities and an isolated proof of concept showed a modest browser win. The next step is a generic compiler design that stays web-buildable and does not bake in AoE algorithms ([performance notes](docs/aoe-performance-optimization.md), [stack-threaded design](docs/wasm-stack-threaded-code.md)).
6. **Direct3D and heavy-app depth** — the broad frame-level surface is real, but D3DRM ProgressiveMesh/Viewer fidelity, deeper MCM/MW3/RCT gameplay, long AoE simulation/save/load, and complete NT Paint remain separate compatibility programs ([DirectX status](apps/directx.md)).
7. **Explicit platform boundaries** — VB6 without its runtime, DX9, full DirectAnimation, and embedded browser engines are still unsupported. 16-bit NE left this list on Aug 15. The project records these as limits rather than hiding them behind silent stubs.

---

## 8. The narrative arc

This is what 147 calendar days of disciplined “fail-fast, fix the real bug,
prove the bounded claim” looks like. Every act made the next one cheaper:

- Act I built the foundation that made everything else *possible*.
- Act II proved real DLLs could be loaded, opening the door to MFC apps.
- Act III turned a notepad emulator into a hosted Win32 platform with COM, registry, VFS, threading, and a multi-app desktop.
- Act IV pulled the UI logic out of JS and put it in WAT — the architecturally important inflection point. Suddenly children, menus, dialogs, and chrome all spoke the same language as the guest. Bugs that crossed the JS/WAT boundary disappeared because the boundary moved down to GDI primitives.
- Act V exploited the Act IV foundation to tackle DirectDraw, audio, skinned windows, and modal-dialog edge cases that would have been unmanageable with the old split.
- Act VI made the platform plausibly Win32: messages routed through a real queue, the x86 decoder's operand-size matrix audited end-to-end, the memory map relocated to be honest about ranges, and D3DIM grew a real rasterizer.
- Act VII is "the long tail" — comboboxes with WS_POPUP shells, dialog focus traversal, FPU env ops, MessageBoxA as a real modal, per-thread cache partitions. The hot bugs no longer crash the foundation; they crash the eighth-most-used Win32 feature in someone's screensaver.
- Act VIII turned Pinball, Notepad, Paint, and the NSIS installer from screenshots into interaction/audio/repaint workflows.
- Act IX shipped the browser surface—Safari, mobile/PWA, recording—while Winamp became the scheduler and multithreading laboratory.
- Act X widened both ends of the machine: workload-driven interpreter optimization below and D3D3/D3D7 plus many more applications above.
- Act XI chose native RichEdit as the next compositional platform test and set an honest bounded target before implementing it.
- Act XII made that target real, then used the same platform pieces to make Paint, RegEdit, Sound Recorder, Volume Control, and Task Manager behave as a connected Win98 desktop.
- Act XIII finished the migration Act IV started. GDI, fonts, WinHelp and Winsock all moved into WAT, and the JavaScript text path was *deleted* rather than deprecated — the host now knows nothing about Windows except how to put pixels on a surface and bytes on a wire. Underneath, a second CPU mode appeared: 16-bit NE. And with the code doubled, the tree got a structural review and spent a day paying off the drift it found.

The progression matters more than the raw commit count. Early sessions asked
whether Notepad could decode. Current sessions argue about `glyf` composite
transforms, Hall phrase tables, whether a wrapped edit should reserve a
scrollbar strip it never paints, and which of two agents owns `01-header.wat`
this minute. Those are platform questions, not demo questions.

Act XIII also changed *how* the work happens. Six sessions in one worktree, an
append-only message board as the coordination primitive, throwaway git indexes
so nobody commits a neighbour's half-finished hunk, and a review pass that four
agents wrote in parallel and one day of work then consumed. The rules in
`CLAUDE.md` stopped being style preferences and became the concurrency protocol.

The next inflection point is likelier to be CPU than pixels now: the raster
surface is WAT-owned and deterministic, so the open architectural payoff is a
generic compiled threaded/block path that buys enough throughput for heavy games
and multimedia — with real browser threads as the other half of that answer. In
parallel, compound-storage persistence can turn the current static-image OLE
slice into reusable document compatibility, and Win16 has a long, shallow tail
that mostly needs apps run and bugs read. The same tracing, focused tests, and
session-to-session written state make each of those programs cumulative instead
of starting over.
