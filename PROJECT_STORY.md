# Wine-Assembly — The Whole Story

*A retrospective from the initial commit (2026-03-26) through 2026-09-04: 3,758 commits across 163 calendar days and 106 active commit days. The last sixteen days alone added about 1,600 of them.*

*Short on time? The [articles](articles/README.md) take one question each — the x86 interpreter, lazy flags, real DLLs, the Win32 layer, software GDI, DirectX, Win16, the virtual LAN, the DOS toy VM, the WATX memory map, scripting the emulator, and working with coding agents — in a few minutes apiece.*

---

## 0. The premise

> Run real Windows 98 `.exe` files in the browser. No source, no recompilation, no porting layer. Just raw WebAssembly Text interpreting x86 machine code, with the Win32 API reimplemented inside the WASM module itself.

This is the kind of project that "shouldn't" be a sprint at all. It started as a single WAT file. It is now about 210k lines of WAT across 61 parts plus 270k lines of browser, test, and tooling JavaScript, compiled by its own vendored compiler for a WAT dialect that allocates the emulator's memory map and type-checks its structs. The app registry names 181 programs: Win98/XP accessories, MFC applications, games, installers, screensavers, DirectDraw, Direct3D Immediate/Retained Mode, OpenGL, audio, RichEdit, and OLE — and since Aug 15 it is no longer only a 32-bit story: 16-bit NE images load, link and run, so the original Windows Entertainment Pack plays in the browser next to its 32-bit remake. Since late August there is a third machine beside them: a toy 8086 VM that runs a corpus of 199 DOS demoscene programs and exists to answer interpreter-design questions the big emulator is too expensive to ask.

The history is also a record of AI-assisted systems work. The implementation is **coded directly in WAT**—there is no C/Rust-to-WASM emulator build—but it should not be described as solely "hand-written." Large parts of the reverse engineering, code, tests, and design were produced through sustained collaboration with Claude Code and Codex. This retrospective was refreshed from all three available records: Git, the repository's Claude session history/memories, and Codex rollout transcripts. The final week is visibly a *multi-agent* record: up to six sessions worked the same tree at once, coordinating through an append-only `messageboard.txt` and building every commit in a throwaway `GIT_INDEX_FILE` so nobody swept up a neighbour's in-flight edits.

---

## 1. The arc, in sixteen acts

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
Act XIV   Aug 20-26   Games as the workload, perf ledger   →  Diablo/StarCraft/Quake II reach play;
                                                              measured nulls written down
Act XV    Aug 26-30   Toy VM, DOS corpus, bring-your-own   →  199 demos captured; ISO/zip mounts;
                      media                                   region JIT; OpenGL command stream
Act XVI   Aug 31-Sep 4 WATX cutover, allocated memory map,  →  288 commits in one day; compiler
                      typed layouts, agent control channel    owns the map; agents play the games
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
08-20..22 117 commits  Diablo to town, StarCraft installer, TrueType hinting, Win16 all playable
08-23     129 commits  Real threads merged; Caesar/Heroes/RCT profiled; single-app phone mode
08-24     144 commits  Hash block cache deleted; RLE fold; Diablo credits; dropdown sweep
08-25     106 commits  bench-loops harness; page-compile measured dead even; MMX on SIMD
08-26      54 commits  Recording every app's audio; toy VM starts; Jazz 2 MMX ratio
08-27..28 129 commits  DOS corpus to 190+; MW3 textures; Half-Life GL; searchable picker
08-29      89 commits  Console APIs; VESA and protected mode; Baldur's Gate previews
08-30     168 commits  BYO media (zip/ISO/C: overlay); OpenGL command buffer; FAR, WinRAR
08-31     288 commits  WATX cutover, legacy retired, allocated map, 1,258 layout sites
09-01     106 commits  Typed pointers and unions; agent control channel; frozen mode
09-02     114 commits  Region JIT whole-program; toyvm site with sound; Shut Down Windows
09-03      87 commits  Installers end to end; GUS/OPL2; Windows demoscene; CD Player
09-04      55 commits  War Wind, AoE campaigns, shell icons; the site made findable

The peak day is now Aug 31 (288 commits), which displaced Aug 14 (154). The
sixteen days from Aug 20 carried 1,586 commits — 43% of the project's entire
history — and the message board logged 96 distinct agent-day rows on Aug 31
alone.
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

## Act XIV — "Games are the workload now" (Aug 20–26)

The instruction that opens this act is one line in a Codex session: *"first
make Diablo work and reach gameplay. then the same for Starcraft and Fallout."*
Everything else in the week is what happens when a platform that was tuned on
Notepad and Solitaire is pointed at Blizzard and id Software.

**Diablo shareware reaches Tristram.** The pre-release demo had been in the
debug dropdown since `35d50d6`; the maintainer then found the shareware edition
on the Internet Archive ("seems like more full version than pre-release") and
insisted its own installer run inside the emulator — *"don't use wine, why? we
want to fix bugs in installer too."* The path from title screen to a Warrior in
town went through a CRT `atexit`/`strstr` gap, a critical-section retry that ate
8 bytes of stack per park, a modal dialog whose `DWLP_DLGPROC` the game reads
back, a nested message wait, and a focus bug that left the class-selection
screen dead. The credits screen's solid white bars turned out to be
`CreateDIBitmap(fdwInit=0)` adopting the caller's colour table (`59f11790`). To
read the game's art without the emulator in the loop, `tools/mpq-dir.js` and
`tools/mpq-extract.js` learned the MPQ container — decryption, PKWARE explode,
PCX-to-PNG — so a wrong sprite could be compared against ground truth.
Save games persist in the browser (`7cc3e1fc`), and the shareware's later
regression ("looks broken again, used to work") was chased through both thread
backends until *"make Diablo Shareware work properly with Threads backend"*
held.

**StarCraft, Heroes II, Caesar III, RollerCoaster Tycoon, Jazz Jackrabbit 2.**
StarCraft's native installer wrote its 35,9xx-byte MPQ short until inline
`EnterCriticalSection` retries stopped consuming stack (`d05c5a3`); the title
then painted fully and stayed there, alive on DirectSound and DirectDraw locks,
which the RE notes record as "not the missing .smk" rather than a fix. Heroes II
hung ten batches after its menu because the CLI parked the whole emulator when
Miles Sound System suspended the main thread from inside its own timer
callback; `host.js` had always exempted that case and `run.js` now agrees. Its
build sound looping forever was traced through the Miles disassembly rather
than worked around (*"don't do workaround. fix for real"*). Caesar III got a
scripted route into a running city and a measured cost of ~143,000 x86 steps per
presented frame. RCT's "no window" report was really "loads after a while at
very low fps", and a per-pixel JavaScript surface conversion was the cost; the
`$invalidate_page` path came out 5.4x cheaper. Jazz 2 became the corpus's first
genuine dual-path MMX binary: with the eight MMX registers as i64 globals and
packed ops widened to wasm SIMD, the same frames present 1.53x faster, and that
number is quoted from *presents counted*, never API calls.

**The performance ledger, including the negatives.** A session opened with the
maintainer's design idea — compile x86 into micro-ops and delete the redundant
side effects at block-compile time — and the counter-question *"didn't you just
measure that optimizing dispatches don't really help in practice?"* The answer
was to build the measurement first. `tools/bench-loops.js` injects hand-encoded
x86 into a live instance and runs both arms in one process, interleaved and
rotated, with a ±1% noise floor against the 24–42% that had made every
whole-app A/B unresolvable on a loaded box. What it and the app-level runs then
established is written in `docs/` as a ledger rather than a changelog: a
dispatch is ~8 ns and a block transfer ~9 ns on top; `$th_rect_run` is worth
~12% on Caesar and `$th_case_chain` ~0% because *the discriminator is whether a
fold removes guest memory accesses*; the RLE sprite-row fold is +7% and a
one-app fold (1 of 287 PEs in the corpus has that shape); page-level compilation
halves decodes and measures dead even at every V8 tier (`ed4b27df`, "built,
measured, not shipped"); the 4,096-slot hash block cache was simply deleted
(`9c257a88`) because pages had replaced it. The hot-block histogram, the
`--batch-stats` stop-reason census and `--decode-stats` exist so that "slow per
batch" stops hiding two opposite causes.

**Real threads merged.** The worker-thread branch that Act XIII probed was
brought to main behind a checkbox (*"make sure that threads disabled unless
checkbox is on + cli has both modes as well"*), with `--threads` and
`--no-threads` as mutually exclusive CLI twins and `--rpc-census` to count the
round trips a worker makes to the main thread — which is what found Winamp's
decoder spending 9,909 of them on `math_pow`.

**Fonts finished properly.** The maintainer refused a shortcut twice in one
day: a C hinter compiled to WAT ("why you have this C code?") and reading
FreeType ("try to not look at freetype code"). The runtime TrueType instruction
engine — fpgm/prep/glyph programs, scaled CVT, twilight points, eight ppem
contexts — was written in WAT from the specification and checked against Arial
12 px bitmaps captured from a real Windows 98 box, with the `m` advance and the
missing top row of a glyph as the oracle that disproved a plausible operand-order
fix within four minutes of proposing it.

**Win16 made playable, not just present.** *"make sure all win16 games are
playable, not just present a window with nothing or crash when you try to
play."* Jigsawed's 6x6 cells, Pipe Dream's help and cursor, Klotski's modal
collision, Tetris focus, IdleWild's honest "it is a screensaver manager, not a
game" — each got its own board thread and its own bounded test; the corrupt
bytes in two Internet Archive images were repaired and documented.

**And the phone.** A single-app mode for small screens (taskbar hidden, the
app's own close button as the exit, maximize then zoom), a recorder that taps
every running app's `AudioContext` instead of the first one, and an iOS
self-test server because Chrome's device emulation cannot reproduce Safari's
retractable toolbars.

The week's messageboard shows the cost of the multi-agent model as clearly as
its speed: a commit built from a stale isolated index silently reverted 35
pre-extracted-icon paths from HEAD and had to be restored by hand; another
agent's phase-2 ZIP mount was deleted wholesale by a neighbour's commit and
re-landed as `6a876ff0`; and cache-version bumps in `index.html` travelled as
"whoever commits this file next, please carry it." The throwaway-index rule
that Act XIII adopted was retired for ordinary staging plus the board (*"just
commit normally, coordinate over messageboard"*).

---

## Act XV — "A second machine, and bring your own disc" (Aug 26–30)

Two things started this act, and neither was on any plan. The maintainer asked
about SIMD for the corpus and got a census; then, because a 16-bit 8086 is the
cheapest possible place to test interpreter designs, a toy VM appeared under
`tools/toyvm/`. And a design question about browser storage — *"what if we
want to extend it to the point where you can bring your own .isos, installer
exes, archives, etc?"* — became a six-phase design doc and then, the same week,
shipped.

**The toy VM and the DOS corpus.** *"let's start a separate collection of dos
games to the sources md for toyvm corpus in addition to pouet demos."* The toy
VM grew from a decoder to real mode with a BIOS, VGA mode 13h and the default
palette (`03a39be7`), hardware interrupts through the IDT (`81a7ff57`), a
vertical-retrace interrupt, VESA for the 640x480 demos, protected mode and V86,
a Sound Blaster whose interrupt timing was two bugs rather than a DMA gap
(`b2044574`), and finally the `AUTORUN`-style question of *what counts as a
frame worth keeping* — "an unlit graphics screen is not a frame", "photograph
the picture, not the flash", "keep what a run SAID apart from what it showed".
The corpus went 193, 194, then 199 of 199 captured. Each dead program got a
commit with its diagnosis as the subject: *"BLINKY: the failure is a bad
return address, not bad code"*, *"JULTRO: the int operand was planted, not
rolled"*, *"ANGEL: the chipset id is never written, because we present no video
BIOS"*, *"DINO: keys do reach it, one row per 775M dispatches"*.

The point of the toy was to measure. Four dispatch shells (`tailcall`,
`repl_tailcall`, `calls`, `switch`) were priced against each other; a micro-op
tier lowered a hot trace past its x86 shape (`b0086961`, tier 3 folding the
segment lookup out); and a region JIT compiled a hot loop into wasm and ran the
demo with it (`041ab7cb`). Two of its early numbers were retracted the same
week — a 0.94x that a snapshot bench had produced, and a "jmp tracing" arm
recorded as a negative — and the correctness rule that made the JIT stick was
that *a region owns the bytes it was compiled from* and must be refused when
the guest rewrites them (`9b67633d`). The findings were written up as a proposal
for the main emulator (`199e2414`, replicated dispatch tails), tried there
experimentally, and merged.

**Bring your own media.** The BYO design (`ba7a2511`) landed in one day at
`650bc6bb`: ZIP archives mount read-only into the VFS, ISO 9660 images mount
as a CD-ROM drive with Joliet, files are served through a byte provider instead
of a buffer so a 600 MB image is never slurped, a writable `C:\` overlay keeps
what an installer writes, save bundles export/import and sync to berrry's data
API, and the browser gets an "Add a game" flow. Civilization II runs from local
media with CD audio ("seems like we can implement cd audio why not" — "don't
look at wine just impl from spec"), and a few days later `.bin`/`.cue` pairs
mount, a bare `.bin` is sniffed for its ISO track and its audio tracks are
inferred from sector statistics, because the maintainer pushed twice past "we
can't recover tracks from stats."

**Console and OpenGL.** *"looks like we need to get far manager as good test
exe for this?"* Console screen buffers, `ReadConsoleOutputA`, input flushing,
persistent titles, device files, viewport handling and browser keys routed into
the console arrived in a two-day run that ended with FAR Manager and WinRAR
launchable and painted correctly. Quake II's OpenGL renderer was too slow with
real threads, and the maintainer's diagnosis — *"can we have the gl calls just
write commands into buffer until it either gets flushed to screen explicitly or
overflows?"* — became the only path: every GL call appends to a command buffer,
textures upload without an extra copy, and the immediate replay path was removed
(`6cc2dcaa`). Half-Life's Uplink demo switches renderers and moves; MechWarrior
3 got perspective texture stages, depth, RGB565 colour-key rows and a threaded
Direct3D rasterizer prototype (`b5baede5`); the D3DIM SDK demos got their
menus, options and FPS counters made honest ("pay attention to what demos
themselves display as fps"). Mouse capture for first-person games went through
several rounds — pointer lock, relative motion gated until capture, raw
movement — because "once I get a bit from center with mouse the aim moves crazy
fast."

**The stub ratchet.** `fable-review.md` was re-run against the tree on Aug 27,
and its silent-success stub count became a build gate that only goes down: 330,
329, 328, 327, 326 across as many commits, each one a real behaviour (registry
disposition, `WaitMessage` blocking, owned popup visibility, recursive mutex
ownership) replacing a return-zero.

The corpus doubled in ambition over these days: Baldur's Gate previews, Icewind
Dale, Deus Ex, Motocross Madness, GTA2, the free GOG titles, Rodent's Revenge in
both editions, and a searchable Win98-style cascading app picker for a debug
dropdown that had become too long to scroll.

---

## Act XVI — "The compiler owns the memory map" (Aug 31–Sep 4)

Aug 31 is the biggest day in the history: 288 commits, most of them one
migration, and the messageboard shows 96 agent-day rows for it. The subject was
the compiler.

**WATX.** The project had always compiled its WAT with its own JavaScript
compiler rather than `wat2wasm`. WATX is a sibling project's dialect of WAT with
`(include ...)`, `(region.declare ...)` and `(layout ...)` — and its `br_table`
syntax differed from standard WAT, which the maintainer had patched away in one
morning ("just make it accept it fine, without standardWat:true") before the
migration plan was written (`f999ec21`). The plan had milestones and a
one-way door, and the day walked through all of them: vendor the compiler and
freeze the legacy baseline (`903ca110`); a decoded-ABI differential gate that
compares what the two compilers emit function by function; a syntax census over
the whole 210k-line closure ("six pieces of standard WAT the census found
missing", each taught to WATX); the `(module ...)` wrapper moved out of the
source so every fragment balances on its own; `src/main.watx` made the one
source order; a test matrix that runs the same tests against both compilers'
artifacts and treats a *symmetric* failure as red rather than silent green.
Then the cutover at byte identity (`23ed9639`), and — the same day, as
scheduled — the legacy compiler retired (`24b79256`), because the next step put
things in the source that only WATX can lower.

**The memory map stopped being hand-placed.** For five months every WAT table
had a hex address typed into a comment and copied into JavaScript. Wave 1
declared the whole fixed map as 160 regions with zero emitted bytes
(`52b22646`); wave 2 found the orphans and the under-declared string block;
wave 3 let the allocator place the map (`c409c554`) and proved it by running a
real app on a *shaken* map — regions rotated, padded, gapped, reseeded — with
pixel-identical output. Four pinned ABI bases survive as literals; everything
else is the allocator's output and `lib/region-map.generated.js` is the one
mirror. The rule that came out of it is in `CLAUDE.md` in bold: an allocated
base copied into JS is now a build failure (`6a01cb65`), because a moved region
breaks JavaScript silently — three literals read zeros for hours before anyone
noticed.

**Structs got names.** A census found 12,587 hand-spelled struct offsets. Over
two days ~1,258 of them became `(layout ...)` field accesses — the winsock
socket, the window record, the DX object, the TrueType point, the DC state and
path, the paint scratch slots — every wave shasum-gated byte-identical against
the previous wasm, so a mislabeled field is the *only* thing byte identity
cannot catch and the doc says so. The GDI object record turned out to be a
discriminated union and got seven variants plus a prefix view; the control-state
records turned out to be a union *harder* than that (no shared prefix, no shared
size, no in-record tag), and the question "why do these even need a common type
vs each control has its own layout?" settled it as thirteen independent
layouts. On Sep 1 the maintainer signed off on typed pointers, layout unions,
views, enums and checked casts (`5c397054` spec, `1fe7824c` implementation), and
the first drift bug the types found was already shipping: `SetWindowLongA`
hand-synced a control's id for one class only, so four other classes reported
one id and notified with another.

The build now runs 28 gates, and the doc that lists them is a paragraph in
`CLAUDE.md`. Several were born from a gate that *stopped running without
failing* — a check pattern-matched the old spelling, the migration removed the
spelling, and the count went 23 to 0 with the build green. "After migrating a
family, grep gates for the old spelling they match on" is now a written lesson.
Measured nulls were written down beside the wins so nobody re-runs them:
`wasm-opt` (0% throughput, 3x startup), a cross-mode parse cache, an accessor
fast-path split (mechanism worked, 0%), and the `(NEXT)` source-inline macro
(3–4% *slower*, reverted at `4baf3f04` with a doc explaining why V8 only
collects the inline win in its top tier).

**Agents drive the games.** *"let's design a feature where we can send
continuous stream of events to cli vm or connect agent to browser. browser
connection should be simple copy pasta."* The control channel (`cda630f8`) gives
`run.js` an HTTP and stdin command stream, the dev server a long-poll hub, and
the debug toolbar an "Agent handoff" button whose link *returns the protocol as
plain text* when fetched. `--frozen` parks the emulator and advances it only on
`step`, so a session can be recorded on the guest clock rather than the wall
clock (`79ad6b64`), and a dashboard watches many sessions at once. The first
uses were exactly what the maintainer asked for: an agent won Minesweeper over
the channel (and was told it forgot to sign its name), played Heroes II in the
user's own tab, and then — *"build profitable park in RCT while taking a
video"* — drove RollerCoaster Tycoon headlessly with audio into an `.mp4`
(`58dedb55`). A frame-pacing census found eight games holding their rate by
spinning on the clock (`fee7d7c1`), which is why vblank parks and clock-spin
parks landed as a released lane.

**The toy VM grew up.** Its region JIT went whole-program — every hot loop and
trace installed into a real run, +35.9% mean CPU on the bench set, detour arms
taking ADDY_II from +15 to +51 — and two of the clocks it was measuring against
turned out to be the harness's own (`d91e54b2`). The corpus report became a
five-page mini-site under `docs/dos-corpus/` with demos paced to real time at a
selectable MIPS, Sound Blaster DMA, PC speaker, an OPL2 synthesized behind ports
388h/389h (`048fcccc`) and a Gravis Ultrasound (`c01c7afa`), all validated by
rendering headless WAVs. Windows demoscene followed: Heaven Seven and four
others run under the Win32 emulator with GLU shims, and a searchable demos page
with per-tile fragments went live.

**Everything else that shipped in four days** reads like a release: Shut Down
Windows, rendered through the emulator's own GDI after the maintainer rejected a
fake DOS prompt ("also try to make other stuff look authentic"); a CD Player
that hot-inserts imported discs; installers for Jazz 2, Total Annihilation,
Pocket Tanks, Icy Tower, Captain Claw and War Wind run end to end in the browser
and chain-launch what they installed; DirectPlay, DDEML, clipboard, menu and
deferred-window-position state moved from JavaScript into owned WAT records;
DX-Ball and Blobby Volley were published to the site with a Sources page
pointing at the authors' archives; touch became a trackpad for relative-mouse
games; Age of Empires' campaigns mount correctly and its cursor restores are
classified by copy size; the vendored WATX compiler compiles the closure
cooperatively so Safari does not stall on it; and on Sep 4 the site and repo
were made findable by search engines, which is the commit this document is
being refreshed in.

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

**Source layout** (the compile order is the `(include ...)` list in
`src/main.watx`, which the build gates against the directory; the tree below
is the Act XIII shape and has since gained `00-regions.wat`, the declared
memory map, plus the loop-idiom matcher, MMX, D3D9 and the Win16 dialog/DDEML
parts — 61 files today):
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
| Heavy demos | AoE, AoE2, Abe, MCM, MW3, RCT, Caesar III, Heroes II | Scripted routes into gameplay with frame-level checks; an agent has driven RCT to a profitable park over the control channel. These are not claimed as complete games |
| Commercial demos and shareware | Diablo shareware, StarCraft, Quake II, Half-Life Uplink, Jazz 2, Deus Ex, Baldur's Gate, Icewind Dale, GTA2, Civilization II, Total Annihilation, Captain Claw, War Wind | Native installers run inside the emulator and chain-launch the game; Diablo reaches town, Quake II and Half-Life render through the OpenGL command stream, StarCraft stops at its title |
| Bring your own media | ZIP, ISO 9660, BIN/CUE, installer EXEs | Read-only mounts through a byte provider, a writable `C:\` overlay, save bundles synced to berrry, CD audio in CD Player |
| Console | FAR Manager, WinRAR | Real screen buffers, console input, directory-change notifications |
| DOS (toy VM) | 199 demoscene programs, plus Settlers II and GTA1 demos | 199/199 captured; paced playback with Sound Blaster, PC speaker, OPL2 and GUS on the corpus mini-site |
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
Lines of WAT           211,125     (61 files in src/, compiled by the vendored WATX)
Lines of JS support    270,840     (lib/ + test/ + tools/)
WASM build            ~1.04 MB     (plus a compatibility build)
Commits                 3,758
Calendar span           163 days   (Mar 26 through Sep 4, inclusive)
Active commit days      106
Avg / active day        ~35 commits
Peak day                288 commits (Aug 31, the WATX cutover)
Aug 20 – Sep 4        ~1,600 commits (43% of all history)
Win32 APIs in the table 3,295
Apps in the registry    181
Focused test files      859 in test/
Build gates             28 in tools/build.sh
Declared memory regions 174, all but 7 placed by the compiler
DOS corpus              199 programs, 199 captured
Per-app RE notes        38 files in docs/re-notes/
History sources         Git + 431 Claude sessions (2.2 GB of transcripts and
                        memory) + 118 Codex rollouts (7.3 GB) + 4,405
                        messageboard entries from 14 named agent identities
```

At Aug 19 the same table read 149,989 lines of WAT in 54 files, 2,131 commits,
a 154-commit peak day and 1,549 board entries.

---

## 7. What's in flight right now

1. **Deploying the WATX tree** — the migration is complete and the site runs on a deploy-candidate branch merged back into main; the open items are the browser's compile-time memory (a sub-100 MB gate for the in-page compiler, and an iPhone pass on the LAN) and the maintainer's sign-off ([plan](docs/watx-migration-plan.md), [region design](docs/watx-region-safety-design.md)).
2. **Region JIT for the main emulator** — the toy VM's region JIT is +36% to +44% on its bench set and the replicated-dispatch proposal was tried in the main emulator; the question is which of those results carries into a 32-bit machine with a 4 GB address space and self-modifying decoders ([toyvm bench](docs/toyvm-bench-20.md), [proposal](docs/repl-tailcall-main-emu.md)). The measured nulls — page compile, accessor split, `(NEXT)` inline, `wasm-opt` — are written down so they are not re-run.
3. **The remaining commercial-demo blockers** — StarCraft's title stall, Diablo II's `SMemReAlloc` critical error, Fallout, and the frame-pacing games that spin on the clock ([RE notes](docs/re-notes/README.md)). Each has a note naming what was ruled out.
4. **Agents as players** — the control channel, frozen mode and the dashboard work; what is missing is a library of per-game drivers (the RCT one exists) and a way to record a session on the guest clock from the browser as well as the CLI ([design](docs/design-agent-control.md)).
5. **Bring-your-own media on Safari** — OPFS overlays, cooperative compilation and CD audio all have Safari-specific fixes from this week; the storage ceiling and the private-browsing slowdown remain documented limits ([design](docs/design-byo-media.md), [Safari](docs/safari-private-browsing.md)).
6. **Phones** — single-app mode, touch-as-trackpad, flippers for Pinball, battery-aware scheduling and a widescreen mode list landed; the per-game control audit exists as a table and most of its adaptations are still unbuilt.
7. **Direct3D and heavy-app depth** — MW3 has a threaded rasterizer prototype and the D3DIM demos have honest FPS counters, but D3DRM ProgressiveMesh/Viewer fidelity, long AoE simulation/save/load and complete NT Paint remain separate compatibility programs.
8. **Explicit platform boundaries** — VB6 without its runtime, full DirectAnimation, and embedded browser engines are still unsupported; DX9 left the list when `pawn` drew its chessboard. The project records these as limits rather than hiding them behind silent stubs, and the silent-stub inventory is a ratchet that only goes down.

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
- Act XIV changed the workload. Once the platform was WAT-owned, the maintainer pointed it at Diablo, StarCraft, Quake II and Heroes II, and the bugs that surfaced were the platform's last untested corners: critical sections under real threads, timer callbacks that suspend their own thread, DirectDraw presented from a worker. The performance program stopped guessing and started keeping a ledger, and half the entries are measured zeros.
- Act XV built a second, smaller machine to ask the questions the first one could not afford, and it paid back in a week: dispatch shells, micro-op tiers and a region JIT were all priced on 199 real DOS programs. In the same days the emulator learned to mount the user's own discs and archives, which is the difference between a demo site and a machine.
- Act XVI is the compiler's act. WATX became the only compiler on the biggest day in the history, the memory map that every earlier act had hand-placed became the allocator's output, and 1,258 struct offsets became named fields with the build checking them. The typed pointers that followed found a shipping bug on their first day. Then the agents were handed a control channel and started *playing* the games they had spent the summer fixing.

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

Acts XIV–XVI ran that protocol at a scale the earlier acts never reached: the
board grew from 1,549 entries to 4,405, one Codex identity alone wrote 2,324 of
them, and Aug 31 shows 96 distinct agent-day rows. The failure modes of that
model are on the record too — a stale index that reverted 35 files, a commit
that deleted a sibling's entire phase, a cache bump that nobody owned — and each
one produced a rule (explicit-path commits, `git status` on the file before
editing *and* before committing, gates that refuse rather than warn). The
maintainer's messages in these sessions are short and mostly corrective:
"don't use wine", "fix for real", "why you have this C code?", "just commit
normally, coordinate over messageboard", "you are not responsible person" when
an agent hesitated over a thirty-year-old shareware notice. The agents did the
reading; the maintainer chose what counted as done.

The next inflection point is a compiled tier for the 32-bit machine. The
region JIT exists and pays on the toy; the main emulator has the ledger of what
does *not* pay, an allocated memory map, typed records and a compiler it owns,
which is the precondition for lowering hot guest loops into wasm without
guessing what they touch. The other open lines are shallower: Safari's storage
and compile ceilings for the media people bring, the per-game control
adaptations for phones, and the handful of commercial demos that still stop at
a title screen with a note explaining why. The same tracing, focused tests, and
session-to-session written state make each of those programs cumulative instead
of starting over.
