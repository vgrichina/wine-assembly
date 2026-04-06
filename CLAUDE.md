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
- **CLI:** `node test/run.js --exe=path/to/exe [options]` — headless execution with auto-build. Key flags: `--verbose`, `--trace`, `--trace-api`, `--trace-gdi`, `--no-close`, `--break=0xADDR`, `--break-api=Name`, `--watch=0xADDR`, `--dump-gdi=DIR`, `--max-batches=N`, `--batch-size=N`
- **PNG render:** `node test/run.js --exe=path/to/exe --png=output.png`

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
| `resources.js` | PE resource parser (menus, dialogs, strings, bitmaps, icons) |
| `dll-loader.js` | DLL loading, relocation, import patching |
| `hlp-parser.js` | Windows HLP file parser (B+tree, Hall phrase decompression) |
| `thread-manager.js` | Multi-thread support via separate WASM instances |
| `storage.js` | localStorage-backed registry and INI file persistence |
| `filesystem.js` | Virtual filesystem for file operations |

## Memory Layout

Guest memory starts at WASM offset `0x12000` (GUEST_BASE). The PE is loaded at its preferred `image_base` (typically `0x400000`) which maps to `GUEST_BASE + (image_base - image_base)` via `g2w` (guest-to-WASM address translation).

Key regions:
- `0x00000100` — String constants (win.ini path, help strings, exe name buffer)
- `0x00002000` — Window table (hwnd→wndproc, 32 entries), class table, userdata
- `0x00004000` — API hash table (8KB, API_HASH_TABLE — below GUEST_BASE, safe from guest writes)
- `0x00012000` — Guest memory (GUEST_BASE, maps guest addresses)
- `0x00E12000` — Guest stack (grows down)
- `0x01012000` — API thunk zone (256KB, THUNK_BASE)
- `0x01052000` — Threaded code cache (1MB, THREAD_BASE)
- `0x01152000` — Block cache index (CACHE_INDEX)
- `0x01162000` — PE staging buffer (2MB, PE_STAGING)
- `0x01D12000` — Heap region (1MB)

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

- `tools/gen_dispatch.js` — Generates `09b2-dispatch-table.generated.wat` (br_table + calls) from `api_table.json`
- `tools/gen_api_table.js` — Generates the API hash table (`01b-api-hashes.generated.wat`)
- `tools/disasm.js` — x86 disassembler for debugging (importable module)
- `tools/hexdump.js` — Memory hexdump utility
- `tools/parse-rsrc.js` — PE resource section parser
- `tools/pe-imports.js` — PE import table dumper (`--all` lists all functions, `--dll=NAME` filters by DLL)
- `tools/pe-sections.js` — PE section header dumper
- `tools/render-png.js` — Headless PNG renderer
- `tools/check-parens.py` — WAT parenthesis balance checker
- `tools/build.sh` — Build script (concat + wat2wasm)

## Test Binaries

Win98/XP executables in `test/binaries/`. Currently tested:

- **Win98 accessories:** notepad.exe, calc.exe, mspaint.exe
- **Entertainment Pack:** SkiFree (ski32.exe), FreeCell, Solitaire, Minesweeper, Reversi, Golf, Pegged, Rattler Race, Taipei, TicTactics
- **NT/XP:** mspaint.exe (NT version, requires msvcrt.dll + mfc42u.dll from `test/binaries/dlls/`), winmine.exe (XP)
- **Other:** Space Cadet Pinball, Winamp 2.95 (NSIS installer)
- **Help files:** `test/binaries/help/` — .hlp files for notepad, calc, freecell, solitaire, mspaint
