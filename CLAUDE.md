# Wine-Assembly

x86 Windows 98 PE interpreter in raw WebAssembly Text (WAT). Runs real Win32 executables in the browser via a Forth-style threaded code x86 emulator.

## Build

```bash
bash tools/build.sh
```

Concatenates `src/parts/*.wat` (alphabetical glob order) into `build/combined.wat`, then compiles with `wat2wasm` to `build/wine-assembly.wasm`. The alphabetical order of filenames IS the source order — file numbering (01-, 02-, etc.) controls concatenation.

**Important:** When adding new handler opcodes to `02-thread-table.wat`, increase `(table $handlers N funcref)` to match the total entry count (0-based index + 1).

## Run

- **Browser:** Open `host/index.html`, select an app, click Launch
- **CLI:** `node test/run.js --exe=path/to/exe [options]` — headless execution with auto-build. Key flags: `--verbose`, `--trace`, `--trace-api`, `--trace-gdi`, `--trace-host=fn1,fn2`, `--no-close`, `--break=0xADDR`, `--break-api=Name`, `--watch=0xADDR`, `--dump-gdi=DIR`, `--max-batches=N`, `--batch-size=N`
- **PNG render:** `node test/run.js --exe=path/to/exe --png=output.png`

## Tracing (reach for this BEFORE editing source to add `console.log`)

Ad-hoc `console.log` / `DBG_*` env vars rot. Use the built-in flags first; extend them when they fall short.

| Flag | What it prints |
|---|---|
| `--trace-api` (`=Name1,Name2`) | Every Win32 API call with args + return; with `=NAMES` filter, only those APIs. Args/returns are typed via `args:[{name,type[,out:true]}]` / `ret` fields in `src/api_table.json` (LPCSTR, HWND, LPMSG, flags:WS, etc.) — untyped entries fall back to an `nargs`-sized hex dump (or 6 dwords if `nargs` is unknown). Args flagged `out:true` are decoded **after** the handler runs (e.g. `LoadStringA buf=`, `GetMessageA msg=`) on a separate `out:` line. |
| `--trace-api-dedup` | Collapse N consecutive identical API trace lines into a `(xN)` summary. |
| `--trace-stack[=DEPTH\|=Name1,Name2\|=Name:DEPTH,...]` | Walk EBP frame chain on each matched API call (default depth 12). `=N` overrides default depth for all; `=Name1,Name2` limits to those APIs; `=Name:N` sets per-API depth. |
| `--trace-gdi` | Every wrapped GDI primitive: CreateBitmap, BitBlt, StretchBlt, FillRect, DrawEdge, DrawText, TextOut, Rectangle, Ellipse, Polygon, MoveTo/LineTo, Arc, SetPixel, SetTextColor, SetBkColor, SetBkMode, SelectObject, DeleteObject, DeleteDC, GetClipBox, LoadBitmap, CreateSolidBrush, GetObject, PatBlt |
| `--trace-dc` | Every `_getDrawTarget` resolution: hdc → resolved hwnd, top-level hwnd, canvas ox/oy, canvas size. Logs NO_CANVAS when resolution fails. Use when a draw call fires but nothing appears — shows which surface each DC lands on. |
| `--trace-reg` | Every registry op (open/query/create/set/enum/close) with key path, value name, and result ("found"/"not found"/actual data). Use to discover which keys an app probes when storage returns empty. |
| `--trace-fs` | Every VFS op: CreateFile (with decoded access/creation + handle/FAIL), GetFileAttributes, FindFirstFile, FindNextFile — each with path and hit/miss result. Use to see which files an app looks for but can't find in the VFS. |
| `--trace-host=fn1,fn2` | Generic wrap of any host import by name — logs raw args + return. Use when no category fits yet. Example: `--trace-host=gdi_draw_edge,wnd_set_state_ptr` |
| `--trace` | Every decoded block's EIP |
| `--trace-seh` | SEH chain operations |
| `--break=0xADDR[,...]` / `--break-api=Name[,...]` | Pause emulator at address / API call |
| `--break-once` | Don't re-arm WASM bp after first hit. Plus prints `bp_first_caller` (sticky `dbg_prev_eip` snapshot from the very first time `$eip == $bp_addr`) — recovers the true caller when the bp lands inside a tight self-loop that would otherwise overwrite `dbg_prev_eip` with the bp address itself. |
| `--trace-at=0xADDR` (`--trace-at-dump=0xADDR:LEN[,...]`) | Log regs + optional hexdump of given regions each time EIP hits addr (no stop). Add `--trace-at-watch` to diff each hexdump vs previous hit (bytes marked `*`). |
| `--watch=0xADDR` / `--watch-byte=ADDR` / `--watch-word=ADDR` (`--watch-value=0xVAL`, `--watch-log`) | Break when memory at ADDR changes. Size: dword/byte/word. `--watch-log` logs every change without stopping into debug prompt (essential for non-interactive runs). `--watch-value` filters to a specific target value. |
| `--show-cstring=0xADDR[,...]` | On every `--trace-at` hit and debug prompt, decode 1-byte-refcount + ASCII-at-+1 CString layout. Prints `[CString@ADDR] rc=N len=M "text"` — great for MFC/Borland apps where strings are packed this way. |
| `--skip=0xADDR[,...]` | Simulate `ret` when EIP hits — step past a fn |
| `--dump=0xADDR:LEN`, `--dump-seh`, `--dump-backcanvas` | Post-run memory hexdump / SEH dump / per-window back-canvas PNGs |

**Extending:** the tracing infrastructure lives in `lib/host-imports.js` under `if (trace.has('gdi'))` — it uses a `wrap(name, fn, formatter)` helper. To add a category, duplicate that block for your category and add a matching `if (TRACE_X) traceCategories.add('x')` in `test/run.js`. The generic `--trace-host=` should cover most one-off investigations without needing a new category.

**Rule:** before adding a `console.log` to source, check that none of the above already covers it. If tracing a new primitive that isn't wrapped yet, add a `wrap(...)` entry to the `gdi` block (or the appropriate one) — that investment pays off on every future session. Source stays clean between sessions; tracing is a runtime flag, not an edit.

## Source Parts (concatenation order)

| File | Purpose |
|------|---------|
| `01-header.wat` | Module declaration, host imports, memory layout, CPU state globals |
| `01b-api-hashes.generated.wat` | **Generated** — FNV-1a hash table for Win32 API name→ID lookup |
| `02-thread-table.wat` | Threaded code function table (opcode → handler mapping) |
| `03-registers.wat` | Register access helpers, lazy flag system (flag_op/flag_res/flag_a/flag_b) |
| `04-cache.wat` | Block cache (decoded x86 → threaded code) |
| `05-alu.wat` | ALU operations (32/16/8-bit), shifts, bit ops, MUL/DIV, SETcc |
| `05b-string-ops.wat` | String operations (movsb/movsd/stosb/stosd/cmps/scas + REP) |
| `06-fpu.wat` | x87 FPU, 16-bit memory ALU handlers |
| `07-decoder.wat` | x86 instruction decoder → threaded code emitter |
| `08-pe-loader.wat` | PE executable loader, import table processing |
| `08b-dll-loader.wat` | DLL loader with relocations, export resolution |
| `09a-handlers.wat` | Win32 API handler functions (core: process, memory, encoding, window props) |
| `09a2-handlers-console.wat` | Console API handlers (screen buffer, cursor, read/write) |
| `09a3-handlers-audio.wat` | Audio/wave API handlers (waveOut*, mmio*, mci) |
| `09a4-handlers-gdi.wat` | GDI API handlers (SelectObject, pens, brushes, BitBlt, text) |
| `09a5-handlers-window.wat` | Window creation & message dispatch (CreateWindowExA, GetMessage, etc.) |
| `09a6-handlers-crt.wat` | C runtime/string handlers (strlen, strcmp, _mbschr, etc.) |
| `09a7-handlers-dispatch.wat` | Sub-dispatchers (Local*, Global*, lstr*, Reg*) + misc handlers |
| `09b-dispatch.wat` | Manual dispatch helpers |
| `09b2-dispatch-table.generated.wat` | **Generated** — br_table dispatch calling handler functions |
| `09c-help.wat` | Window table, class table, WAT-native help system |
| `10-helpers.wat` | String/memory helpers, heap allocator, resource walker |
| `11-seh.wat` | Win32 Structured Exception Handling |
| `12-wsprintf.wat` | wsprintf/sprintf implementation |
| `13-exports.wat` | WASM exports (run, get_eip, register accessors, etc.) |

## JS Libraries (`lib/`)

| File | Purpose |
|------|---------|
| `mem-utils.js` | Shared memory utilities (readStrA, readStrW, g2w) |
| `host-imports.js` | Shared WASM host imports (GDI, file I/O, registry, help system) |
| `renderer.js` | Win98 canvas renderer (windows, controls, menus, dialogs, drawing) |
| `renderer-input.js` | Renderer input handling (mouse, keyboard, menu interaction) |
| `dib.js` | DIB → RGBA decoder (1/4/8/24/32 bpp + RLE4/RLE8); used by both guest BITMAP rendering and host icon extraction |
| `resources-icon.js` | Browser-side PE walker that extracts the desktop icon from each app's exe at page load (RT_GROUP_ICON → RT_ICON → DIB → data URL) |
| `dll-loader.js` | DLL loading, relocation, import patching |
| `hlp-parser.js` | Windows HLP file parser (B+tree, Hall phrase decompression) |
| `thread-manager.js` | Multi-thread support via separate WASM instances |
| `storage.js` | localStorage-backed registry and INI file persistence |
| `filesystem.js` | Virtual filesystem for file operations |
| `compile-wat.js` | Browser-side WAT → WASM compiler (wraps wabt.js) |

### Rendering surfaces

One offscreen **back-canvas** per top-level hwnd (sized to full window), allocated lazily by `renderer.getWindowCanvas`. All guest GDI and all WAT-dispatched child WM_PAINT draws land here via `_getDrawTarget` in `host-imports.js`. `repaint()` blits each back-canvas to the screen in z-order — the screen canvas is a composite target, not a drawing target.

Child controls painted via `_drawWatChildren` use `_activeChildDraw = { canvas, ctx, ox, oy, hwnd }` to short-circuit DC resolution. `ox/oy` are **window-local** (back-canvas coords, not screen coords) so children composite coherently with the guest's own paint output.

Don't add a second drawing surface. If a GDI call needs to hit the screen, route it through the parent window's back-canvas with the right offset.

## Memory Layout

128 MB flat WASM linear memory. Guest memory starts at WASM offset `0x12000` (GUEST_BASE). The PE is loaded at its preferred `image_base` (typically `0x400000`) which maps to `GUEST_BASE + (image_base - image_base)` via `g2w` (guest-to-WASM address translation): `g2w(guest) = guest - image_base + GUEST_BASE`.

Key regions:
- `0x00000100` — String constants (win.ini path, help strings, exe name buffer)
- `0x00004000` — API hash table (12KB, API_HASH_TABLE)
- `0x00007000` — WND_RECORDS, CONTROL_TABLE, CONTROL_GEOM, CLASS_RECORDS, TIMER_TABLE, PAINT_SCRATCH, SCROLL_TABLE, FLASH_TABLE, WND_DLG_RECORDS (all below GUEST_BASE, end at 0xF000)
- `0x00012000` — Guest memory (GUEST_BASE, maps guest addresses)
- `0x03C12000` — Guest stack (1MB, grows down)
- `0x03D12000` — Heap region (1MB)
- `0x03E12000` — API thunk zone (256KB, THUNK_BASE)
- `0x03E52000` — Threaded code cache (4MB, THREAD_BASE)
- `0x04252000` — Block cache index (64KB, CACHE_INDEX)
- `0x04262000` — PE staging buffer (2MB, PE_STAGING)
- `0x04462000` — DLL table (512B)
- `0x07FF0000` — DX_OBJECTS / COM_WRAPPERS (high memory, outside g2w bounds)

See [docs/memory-map.md](docs/memory-map.md) for the full annotated layout, comparison with Windows 98 kernel/user memory model, and analysis of what's emulator-private vs guest-accessible.

## Message / Event Handling

GetMessageA in `09a5-handlers-window.wat` delivers messages in a priority-based phased sequence:

1. **WM_QUIT** — if `$quit_flag` is set
2. **Pending child WM_CREATE** — queued during CreateWindowExA for child controls
3. **Pending child WM_SIZE** — follows child WM_CREATE
4. **Post queue** (`$post_queue_count`, memory at 0x400) — drained FIFO, 64-slot ring of {hwnd, msg, wParam, lParam} 16-byte entries. PostMessageA and TranslateAcceleratorA write here.
5. **Pending main WM_SIZE** (`$pending_wm_size`) — set by CreateWindowExA, consumed after post queue drain
6. **Startup phases** — sequential one-shot messages: WM_ACTIVATEAPP → WM_ACTIVATE → WM_SETFOCUS → WM_ERASEBKGND
7. **Host input poll** — `$host_check_input()` returns packed `(wParam<<16)|(msg&0xFFFF)`, with hwnd/lParam via separate imports
8. **WM_PAINT** — if `$paint_pending` is set for main window
9. **Paint queue** — per-child-hwnd paint queue (`$paint_queue_pop`)
10. **Timers** — `$timer_table` walk, delivers WM_TIMER
11. **WM_NULL** (idle) — returned when nothing is pending

**ShowWindow** delivers WM_SIZE synchronously by redirecting EIP to the wndproc (not via the message queue). This happens inside `$handle_ShowWindow` when the target is `$main_hwnd` and `$pending_wm_size` is non-zero.

**SendMessageA** (`$handle_SendMessageA`) dispatches synchronously: pushes wndproc args on the guest stack, sets EIP to the target wndproc, and uses a CACA0005 continuation thunk to resume the caller when the wndproc returns.

**Input injection (test harness):** `test/run.js` supports `--input=BATCH:ACTION:ARGS,...` for keydown/keyup/keypress/click/dblclick/post-cmd/png and more. The renderer's `inputQueue` feeds into `check_input()`. See lines 82-159 in run.js for the full list.

## Key Concepts

- **Threaded code:** x86 is decoded into a sequence of (opcode, operand) pairs stored in the thread cache. The `$next` function advances the thread pointer and dispatches via indirect call through the handler table.
- **Lazy flags:** Flags (ZF, SF, CF, OF) are not computed after every instruction. Instead, `flag_op`, `flag_a`, `flag_b`, `flag_res` are stored, and flags are computed on demand by `$get_zf`, `$get_cf`, etc. `flag_sign_shift` is 31 for 32-bit ops, 15 for 16-bit, 7 for 8-bit.
- **g2w / w2g:** Convert between guest (x86) addresses and WASM linear memory addresses. `g2w(guest) = guest - image_base + GUEST_BASE`.
- **API thunks:** Imported Win32 functions are replaced with thunk addresses. When EIP enters the thunk zone, `$win32_dispatch` handles the call.
- **Dispatch handlers:** Each Win32 API has a `$handle_{Name}` function in `09a-handlers.wat` with signature `(param $arg0-4 i32) (param $name_ptr i32)`. The generated `09b2-dispatch-table.generated.wat` contains the br_table that calls these. To add a new API: add it to `api_table.json`, write `$handle_{Name}` in `09a-handlers.wat`, run `node tools/gen_dispatch.js`.
- **Fail-fast stubs:** Unimplemented API handlers call `$crash_unimplemented` which traps with `unreachable`. Do NOT replace these with silent stubs that return 0 — silent stubs hide bugs and make them much harder to debug. When an app hits an unimplemented API, the crash log tells you exactly what to implement next. Implement the real behavior or leave the crash.
- **Yield mechanism:** For async operations (DLL loading, help file fetching), WASM sets `$yield_reason` and returns control to JS. The JS event loop handles the async work, clears the yield, and resumes WASM. Yield reasons: 1=waiting, 2=exited, 3=com_load_dll, 4=help_load.
- **WAT-native windows:** Windows with wndproc `0xFFFF0001` are handled entirely in WAT (e.g., help window). `$wat_wndproc_dispatch` routes messages to the appropriate WAT wndproc.

## Tools

- `tools/gen_dispatch.js` — Generates `09b2-dispatch-table.generated.wat` (br_table + calls + `$init_dx_com_thunks`) from `api_table.json`. COM vtable start IDs are auto-computed from interface prefixes (e.g. `IDirectDraw_*`), so adding a new API never requires manual ID fixups.
- `tools/gen_api_table.js` — Generates the API hash table (`01b-api-hashes.generated.wat`)
- `tools/disasm.js` — x86 disassembler for debugging (importable module)
- `tools/disasm_fn.js` — disassemble at one or more VAs: `node tools/disasm_fn.js <exe> 0xADDR[,0xADDR,...] [count]`. Warns when the start looks like a mid-instruction desync.
- `tools/xrefs.js` — find all references to a data/code VA: `node tools/xrefs.js <exe> 0xADDR [--near=0xN] [--code]`. Classifies each ref as `load`/`store`/`branch`/`other`; handles Borland-style code-in-data sections (sections named `CodeSeg`/`DataSeg` even when flagged data). Use `--near` to catch branches into any byte of a trampoline region.
- `tools/find_fn.js` — given an interior VA, locate the enclosing function's entry: `node tools/find_fn.js <exe> 0xADDR[,0xADDR,...]`. Walks back to the nearest `55 8B EC` prologue, `CC`/`90` padding boundary, or `C3`/`C2` ret. Use when a trace hit lands mid-function and you need the entry for `--break=` or a clean `disasm_fn` start.
- `tools/find_field.js` — find all accesses to a struct field `[reg+OFFSET]` by scanning ModRM displacements: `node tools/find_field.js <exe> 0xOFF [--reg=esi,edi] [--op=write,read,lea,cmp,imm,indirect] [--context=N] [--fn]`. Use when REing C++ class layouts to locate setters/getters of a specific member offset.
- `tools/find_vtable_calls.js` — locate `call dword [reg+disp]` (FF /2) sites in a PE/DLL by vtable slot or raw displacement: `node tools/find_vtable_calls.js <pe> <slot>` (or `--disp=0xNN`, or `--slots` for a per-slot histogram). Filter base reg with `--reg=ecx,edx`. Use to enumerate COM call sites for a specific interface method (e.g. slot 32 = `IDirect3DRMFrame::AddVisual` at disp 0x80). Complements `find_field.js` (data accesses) and `xrefs.js` (data-VA refs), neither of which filter call-indirects by displacement.
- `tools/find_string.js` — find every VA where a string literal occurs in a PE: `node tools/find_string.js <exe> "<literal>" [--utf16] [--all]`. Prints `VA  [section]  raw=0xOFF  "literal"`. Use as the first step of a string-driven xref hunt — feed the printed VA into `tools/xrefs.js`.
- `tools/file2va.js` — convert PE file offsets ↔ VAs: `node tools/file2va.js <exe> 0xOFFSET[,...]` or `--va=0xVA[,...]`. Use after `strings -t x` / hex-editor finds, or to translate a VA back to a file offset for patching/inspection.
- `tools/dump_va.js` — peek static PE/DLL bytes at one or more VAs: `node tools/dump_va.js <exe> 0xVA[,0xVA,...] [len=32]`. Marks BSS ranges (no raw data) explicitly so a zeroed sentinel doesn't masquerade as initialized data. Use this instead of `--trace-at-dump` when you only need to inspect static `.rdata`/`.data`.
- `tools/vtable_dump.js` — dump function pointers from a vtable in a PE/DLL: `node tools/vtable_dump.js <exe> 0xVTABLE_VA [n_slots=16]`. Per slot, prints slot index, slot address, target VA, and the first instruction at the target — fast way to enumerate COM/C++ vtables and verify each slot points at a real prologue rather than NULL/garbage.
- `tools/hexdump.js` — Memory hexdump utility
- `tools/parse-rsrc.js` — PE resource section parser
- `tools/pe-imports.js` — PE import table dumper (`--all` lists all functions, `--dll=NAME` filters by DLL)
- `tools/pe-sections.js` — PE section header dumper
- `tools/render-png.js` — Headless PNG renderer
- `tools/check-parens.js` — WAT parenthesis balance checker (auto-diffs vs git HEAD)
- `tools/build.sh` — Build script (concat + wat2wasm)
- `tools/deploy-berrry.js` — Deploy to berrry.app. `--update` updates an existing app and by default fetches the server's sha256 manifest, then uploads only files whose hash differs (so a no-op redeploy ships zero files). `--full` forces a complete reupload. `--files=a,b,c` uploads an explicit comma-separated list of repo-relative paths and skips diffing. Note: by default `--update` *will* push uncommitted working-tree changes, since the diff is against the live server, not git.

## Test Binaries

Win98/XP executables in `test/binaries/`. Currently tested:

- **Win98 accessories:** notepad.exe, calc.exe, mspaint.exe
- **Entertainment Pack:** SkiFree (ski32.exe), FreeCell, Solitaire, Minesweeper, Reversi, Golf, Pegged, Rattler Race, Taipei, TicTactics
- **NT/XP:** mspaint.exe (NT version, requires msvcrt.dll + mfc42u.dll from `test/binaries/dlls/`), winmine.exe (XP)
- **Other:** Space Cadet Pinball, Winamp 2.95 (NSIS installer)
- **Help files:** `test/binaries/help/` — .hlp files for notepad, calc, freecell, solitaire, mspaint
