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
- **CLI:** `bash tools/run.sh [options] path/to/exe` — headless execution with tracing/debugging flags (-v verbose, -t trace, -a trace-api, -B addr breakpoint, -W addr watchpoint)
- **PNG render:** `tools/run.sh -p output.png path/to/exe`

## Source Parts (concatenation order)

| File | Purpose |
|------|---------|
| `01-header.wat` | Module declaration, host imports, memory layout, CPU state globals |
| `01b-api-hashes.wat` | FNV-1a hash table for Win32 API name→ID lookup |
| `02-thread-table.wat` | Threaded code function table (opcode → handler mapping) |
| `03-registers.wat` | Register access helpers, lazy flag system (flag_op/flag_res/flag_a/flag_b) |
| `04-cache.wat` | Block cache (decoded x86 → threaded code) |
| `05-alu.wat` | ALU operations (32/16/8-bit), shifts, bit ops, MUL/DIV, SETcc |
| `06-fpu.wat` | x87 FPU, 16-bit memory ALU handlers |
| `07-decoder.wat` | x86 instruction decoder → threaded code emitter |
| `08-pe-loader.wat` | PE executable loader, import table processing |
| `08b-dll-loader.wat` | DLL loader with relocations, export resolution |
| `09-dispatch.wat` | Win32 API dispatch (thunk calls → API implementations) |
| `10-helpers.wat` | String/memory helpers, heap allocator, resource walker |
| `11-seh.wat` | Win32 Structured Exception Handling |
| `12-wsprintf.wat` | wsprintf/sprintf implementation |
| `13-exports.wat` | WASM exports (run, get_eip, register accessors, etc.) |

## Memory Layout

Guest memory starts at WASM offset `0x12000` (GUEST_BASE). The PE is loaded at its preferred `image_base` (typically `0x400000`) which maps to `GUEST_BASE + (image_base - image_base)` via `g2w` (guest-to-WASM address translation).

Key regions:
- `0x00012000` — Guest memory (9MB, maps guest addresses)
- `0x00912000` — Guest stack (grows down)
- `0x00B12000` — API thunk zone (256KB)
- `0x00B52000` — Threaded code cache (1MB)
- `0x00C52000` — Block cache index
- `0x00C62000` — PE staging buffer (2MB)

## Key Concepts

- **Threaded code:** x86 is decoded into a sequence of (opcode, operand) pairs stored in the thread cache. The `$next` function advances the thread pointer and dispatches via indirect call through the handler table.
- **Lazy flags:** Flags (ZF, SF, CF, OF) are not computed after every instruction. Instead, `flag_op`, `flag_a`, `flag_b`, `flag_res` are stored, and flags are computed on demand by `$get_zf`, `$get_cf`, etc. `flag_sign_shift` is 31 for 32-bit ops, 15 for 16-bit, 7 for 8-bit.
- **g2w / w2g:** Convert between guest (x86) addresses and WASM linear memory addresses. `g2w(guest) = guest - image_base + GUEST_BASE`.
- **API thunks:** Imported Win32 functions are replaced with thunk addresses. When EIP enters the thunk zone, `$win32_dispatch` handles the call.

## Tools

- `tools/gen_dispatch.js` — Generates the Win32 API dispatch switch from a spec
- `tools/gen_api_table.js` — Generates the API hash table (`01b-api-hashes.wat`)
- `tools/disasm.js` — x86 disassembler for debugging
- `tools/hexdump.js` — Memory hexdump utility
- `tools/parse-rsrc.js` — PE resource section parser
- `tools/check-parens.py` — WAT parenthesis balance checker

## Test Binaries

Win98/XP executables in `test/binaries/`. Currently tested: notepad.exe, calc.exe, SkiFree (ski32.exe), FreeCell, Solitaire, MSPaint (requires msvcrt.dll + mfc42u.dll from `test/binaries/dlls/`).
