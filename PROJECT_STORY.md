# Wine-Assembly — The Whole Story

*A retrospective from initial commit (2026-03-26) to today (2026-04-15). 430 commits in 21 days.*

---

## 0. The premise

> Run real Windows 98 `.exe` files in the browser. No source, no recompilation, no porting layer. Just raw WebAssembly Text interpreting x86 machine code, with the Win32 API reimplemented inside the WASM module itself.

This is the kind of project that "shouldn't" be a 3-week sprint. It started as a single WAT file. It is now 36k lines of WAT + 16k lines of JS that boots Notepad, Calc, Solitaire, Spider, FreeCell, Minesweeper (98 + XP), SkiFree, the Entertainment Pack, MS Paint NT (via real MFC42/MSVCRT), Pinball, Winamp 2.95 (skin + audio in flight), and a fleet of Plus! 98 screensavers — including DirectDraw + 8bpp Marbles.

---

## 1. The arc, in five acts

```
Act I    Mar 26-28   Decoder, lazy flags, FPU, SEH    →  Notepad runs
Act II   Mar 29-31   DLL loader, GDI, MSPaint MFC     →  CRT init completes
Act III  Apr 01-04   Multi-app shell, COM, NSIS       →  23 PASS / 12 FAIL
Act IV   Apr 05-09   Controls-as-windows refactor     →  Logic into WAT
Act V    Apr 10-15   DDraw, audio, dialogs, Winamp    →  Skinned UIs + sound
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
- DDraw QueryInterface: must AddRef (slot-0 reuse bug — that's the memory entry today)
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

**Apr 15 (today, ongoing): the unification pass**
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

## 2. Architecture today

```
┌────────────────────── Browser / Node ──────────────────────┐
│                                                            │
│  index.html / test/run.js                                  │
│       │                                                    │
│       ▼                                                    │
│  ┌────────────┐   GDI / audio / file / registry imports    │
│  │ JS host    │◄──────────────────────────────┐            │
│  │ lib/*.js   │   ↑ JS now owns ONLY:         │            │
│  └─────┬──────┘     • canvas blits            │            │
│        │ instantiate• audio output            │            │
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
│  │       └─── thunk EIP → $win32_dispatch ◄────────────┘   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**Source layout (concatenation order = filename alphabetical):**
```
src/parts/
├─ 01-header.wat               ┐
├─ 01b-api-hashes.gen.wat      │  PE / CPU plumbing
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
├─ 09a8-handlers-directx.wat   ┘
├─ 09b-dispatch.wat            ┐
├─ 09b2-dispatch-table.gen.wat │  dispatch + window mgr
├─ 09c-help.wat                │
├─ 09c2-treeview.wat           │
├─ 09c3-controls.wat           │
├─ 09c4-defwndproc.wat         │
├─ 09c5-menu.wat               ┘
├─ 10-helpers.wat
├─ 11-seh.wat
├─ 12-wsprintf.wat
└─ 13-exports.wat
```

**Rendering surfaces (Apr 15 unification):**
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

---

## 3. What runs

```
Tier               App                              Status
─────────────────────────────────────────────────────────────────
Daily-driver       Notepad                          ✅ full edit + Find dialog + help
                   Calc (std + scientific)          ✅ full
                   Solitaire                        ✅ full + scoring verified
                   Spider Solitaire                 ✅ full
                   FreeCell                         ✅ full
                   Minesweeper (98 + XP)            ✅ full
                   SkiFree                          ✅ full
                   Entertainment Pack (8 games)     ✅ Golf, Reversi, Pegged,
                                                       Taipei, TicTactics, Rattler,
                                                       Pyramid, Chess
Real DLL pipeline  MS Paint NT (MFC42 + MSVCRT)     ✅ basic drawing
                   Wordpad                          🟡 partial
                   RegEdit                          ✅ basic
                   Win98 Tour                       ✅
DirectDraw / D3D   Marbles screensaver              ✅ rendering (8bpp + palette)
                   Plus! 98 screensavers            🟡 most boot
                   D3DIM screensavers               🟡 phase 0/0.5: vtables stub-out
Audio              Winamp 2.95                      🟡 UI works, MP3 streaming
                                                       in progress (WHDR_DONE today)
Heavy              Space Cadet Pinball              🟡 boots, Player 1 label OK
                   Winamp installer (NSIS)          🟡 TreeView OK, zlib path stuck
Web shell          Multi-app desktop with PE icons  ✅ icons extracted from each
                                                       exe at load
```

---

## 4. Patterns that emerged

The CLAUDE.md memory file captures the lessons. The big ones:

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
```

---

## 5. Tooling that paid off

```
tools/build.sh              Concat src/*.wat alphabetically → wat2wasm
tools/gen_dispatch.js       api_table.json → 09b2-dispatch-table.gen.wat
tools/gen_api_table.js      FNV-1a hash table for API name→ID
tools/disasm.js             x86 disasm (importable; used by tracing too)
tools/hexdump.js            Memory hexdump
tools/parse-rsrc.js         PE resource section parser
tools/pe-imports.js         PE import table dumper (--all, --dll=NAME)
tools/pe-sections.js        PE section header dumper
tools/render-png.js         Headless PNG renderer
tools/check-parens.js       WAT paren balance checker
tools/find-refs.js          Reference finder
tools/deploy-berrry.js      Ship to berrry.app with sha256-diff incremental
                            uploads (Apr 11)
test/run.js                 Headless emulator with rich --trace flags
test/test-all-exes.js       Smoke test suite — 23 PASS / 12 FAIL / 10 WARN
                            baseline (Apr 3); has only grown since
```

The `--trace-*` family in particular pays compounding interest. Every time someone added a new category instead of a one-off `console.log`, future investigations got faster.

---

## 6. The numbers

```
Lines of WAT            36,052     (30 files in src/parts)
Lines of JS support     16,384     (lib/ + test/ + tools/)
Commits                 430
Days                    21
Avg commits/day         ~20
Peak day                49 (Apr 3)
Test binaries           50+ exes (98 apps, EP, NT, XP, Plus!, screensavers,
                                   installers, Winamp plugins)
Per-app investigations  24 *.md files at repo root
```

---

## 7. What's in flight right now

1. **Winamp MP3 streaming** — deferred WHDR_DONE just reinstated; survey dialog routing bug still open (`winamp.md`).
2. **D3D Immediate Mode** — phase 0/0.5 vtable stubs done; needs real device state engine (`direct3d-im.md`).
3. **NSIS installer** — TreeView fine, zero file extraction; suspected zlib decompression bug in x86 emu (`winamp-installer.md`).
4. **Pinball gameplay** — boots and shows table, full game loop not yet driving.
5. **CRT unblocks for MCM** — reaches KVDD.DLL video init (700+ API calls deep) but needs more 16-bit thunking.

---

## 8. The narrative arc

This is what 21 days of disciplined "fail-fast, fix-the-real-bug, no-silent-stubs" looks like. Every act made the next one cheaper:

- Act I built the foundation that made everything else *possible*.
- Act II proved real DLLs could be loaded, opening the door to MFC apps.
- Act III turned a notepad emulator into a hosted Win32 platform with COM, registry, VFS, threading, and a multi-app desktop.
- Act IV pulled the UI logic out of JS and put it in WAT — the architecturally important inflection point. Suddenly children, menus, dialogs, and chrome all spoke the same language as the guest. Bugs that crossed the JS/WAT boundary disappeared because the boundary moved down to GDI primitives.
- Act V exploited the Act IV foundation to tackle DirectDraw, audio, skinned windows, and modal-dialog edge cases that would have been unmanageable with the old split.

Today's last commit is "Delete dead JS edit paint path." That is the shape of a mature codebase: things being *removed* because they're no longer needed.

The next inflection point is probably full D3D Immediate Mode (real geometry, not just vtable round-trips) and finishing the audio pipeline so Winamp plays a song end-to-end. After that, the remaining bottleneck is whatever the next exe demands — and there are 50+ in the test suite waiting their turn.
