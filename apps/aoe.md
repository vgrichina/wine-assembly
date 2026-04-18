# Age of Empires (demo) — Progress

**Binary:** `test/binaries/shareware/aoe/aoe_ex/Empires.exe`
**Image base:** 0x00400000
**Entry point:** 0x0051CD60
**Data files:** `test/binaries/shareware/aoe/aoe_ex/data/` — sounds.drs, graphics.drs, Terrain.drs, Border.drs, Interfac.drs
**Window:** 640×480 (or 800×600), title "Age of Empires"
**Status (2026-04-18):** Splash screen now renders correctly on offscreen surface after two DirectDraw fixes this session:
1. `IDirectDrawPalette::SetEntries` memcpy args were swapped (copying from pal_wa to caller, same code as GetEntries) — parallel agent fixed.
2. `IDirectDrawSurface::Blt` COLORFILL path was missing 8bpp case — else-branch used `i32.store` (4 bytes, `* 4` stride) producing stripey fills on all 8bpp surfaces. Added `bps==1` branch using `i32.store8`. This was polluting offscreens and primary with stripe patterns — fixed unlocks the full splash render (confirmed via `--dump-ddraw-surfaces`). Same fix also visually unlocks MARBLES and Abe.

**Prior status (2026-04-16):** CLI now reaches 1195 API calls after fix to `inc byte [esp+0x13]` decoder bug (see below). Next failure is EIP=0 after a long bounce-loop between `0x49d9d1` ↔ `0x49dd56` (~2500 iterations) returns through a multi-level epilogue cascade. At block entry to `0x49dd56` the stack shows `[esp]=0` (saved edi=0), with return address `0x43d0c0` just above — so the null gets popped as EIP from a higher frame after several `ret`s. Fn containing `0x49dd56` starts at `0x49dd20` (thiscall, 3 stack args + `ecx=this`). Stack layout at crash entry: ESP=0x3ffd678, frame=[0, 0x7a8b30, 0x258, 0x258, 0x43d0c0, 0, ...]. Need to walk further up — likely a caller didn't push a real ret addr, or the unit-grid loop corrupted its own frame. Didn't pursue further this session.

## vsprintf loop — FIXED (decoder bug)

Root cause: `$emit_unary_m8` (opcode 0xFE group, INC/DEC r/m8) in `src/07-decoder.wat` was missing the `$mr_simple_base` fast-path that every other `emit_*_m*` helper has. So for `inc byte [esp+0x13]`, it fell through to `$emit_sib_or_abs`, whose "no index" branch returned raw `mr_disp` (0x13) as the address — causing `inc` to read/write guest address 0x13 instead of ESP+0x13. The exit flag `[esp+0x13]` therefore stayed 0 forever, so the format-parser loop never exited.

Fix: widened `$emit_sib_or_abs` to also emit the `compute_ea_sib` prefix when `mr_base != -1` (base-only `[reg+disp]`). That route sets `ea_temp = base + disp` correctly, and `th_unary_m8` (via `$read_addr`) picks it up via the SIB sentinel. Callers with the `mr_simple_base` fast-path return before reaching `emit_sib_or_abs`, so they're unaffected. Regression-tested notepad/calc/mspaint/ski32/FreeCell.

## What works

- DirectDrawCreate → DD_OK
- EnumDisplayModes with multi-mode callback (640×480×8/16, 800×600×8/16)
- SetCooperativeLevel(hwnd, DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN)
- SetDisplayMode(800, 600, 8)
- CreatePalette + SetEntries (256-color)
- CreateClipper + SetHWnd
- CreateSurface (primary + multiple offscreens), GetSurfaceDesc, GetCaps
- Blt loops (screen clear/setup), SetPalette, SetClipper
- DirectSound: CreateSoundBuffer × many + Lock/Unlock → sound WAVs loaded into DSB
- All 5 DRS files loaded (sounds.drs via CRT `_read`; graphics/Terrain/Border/Interfac via `CreateFileMappingA`+`MapViewOfFile`)

## Current blocker: vsprintf loop at 0x0051F570

After audio setup and initial palette+Blt cycles, EIP pins in a tight 2-block loop between `0x51f6af` and `0x51f6e0` inside a variadic format-string parser:

- Function prologue: `0x51F570` — `sub esp, 0x1d0; push ebx; ... mov al,[arg1]; test al,al; jz 0x5201c2`
- Called from `0x005196A0` (wrapper), which in turn is called from many sites — this is the CRT/MFC `vsprintf`/`_vsnprintf` implementation
- Loop body at `0x51F67C`: reads ctype table at `[0x557900]`, dispatches via byte-table `0x520210` + dword-jump-table `0x5201EC` for format-flag chars; full-conversion dispatch further on via `[0x520260 + edx*4]`
- ECX = format-string cursor, `inc ecx` each iteration; saved to `[esp+0x1e8]`
- Format argument for the first observed call: VA `0x0054C400` = `"%s %s %s %d %d   %s %s %s %d %d   %s %s %s %d %d   ..."` (225 bytes, null-terminated) — looks like a game-state serializer that formats many records at once
- Call args (caller 0x519630 → 0x5196A0 → 0x51F570): `arg0=dst buf (stack)`, `arg1=format ptr`, `arg2=vararg list ptr`, `arg3=0`

Observed ECX progression inside a single stuck call:
- batch 1000  → 0x00551388
- batch 2000  → 0x00576B62
- batch 20000 → 0x009FB020

ECX crosses the null terminator at `0x54C4E1` almost immediately and keeps advancing into unrelated `.data` (and then past PE image end at 0x772D74). The outer-loop exit at `0x51F591` (`test al,al; jz …`) only fires once, at function entry on the first byte of the format; the inner loops have conversion-char dispatches that branch on cursor-read bytes, so as soon as a byte happens to decode as "continue-scanning" behavior, the loop never exits.

Emulator is not crashing the handler, not missing an API, and the format data itself is valid on disk. Verified at runtime: `[0x557900]` (ctype ptr) = `0x55790A`, which is a valid self-referential CRT `_pctype` layout — not the bug.

### Dispatch-table decode (new)

Flag-char byte table at `0x520210` (78 entries, chars `0x2a..0x77`) and jump table at `0x5201EC`:

Jump-table targets:
- `jt[0] = 0x51F740` — `inc [esp+0x1b]` then loop back (assign-suppress `*`)
- `jt[1] = 0x51F74A` — **loop back with no state change**
- `jt[2] = 0x51F70D` — `I64` prefix parse (checks `[ecx+1]=='6' && [ecx+2]=='4'`)
- `jt[3] = 0x51F730` — `inc [esp+0x1a]`, loop back
- `jt[4] = 0x51F74A` — **loop back with no state change** (same as jt[1])
- `jt[5] = 0x51F6F7` — `dec [esp+0x1a]; dec [esp+0x19]`, loop back
- `jt[6] = 0x51F736` — `inc [esp+0x1a]`, loop back
- `jt[7] = 0x51F73A` — `inc [esp+0x1a]; inc [esp+0x19]`, loop back
- `jt[8] = 0x51F746` — **inc [esp+0x13] (exits loop)**

Byte-table indices that are NOT 0x08 (i.e. do not exit the loop):
- bt[0]=0x00 → char `*` (0x2A)
- bt[28]=0x01 → char `F` (0x46) — **loop-back only, no state change**
- bt[31]=0x02 → char `I` (0x49) — I64 size prefix
- bt[34]=0x03 → char `L` (0x4C) — long prefix
- bt[36]=0x04 → char `N` (0x4E) — **loop-back only, no state change**
- bt[66]=0x05 → char `l` (0x6C) — long prefix (`l`)
- bt[70]=0x06 → char `p` (0x70) — precision/pad flag?
- bt[77]=0x07 → char `w` (0x77) — wide prefix

All other chars in 0x2A..0x77 (including `s`, `d`, `%`) map to 0x08 and exit. Null terminator (0x00 < 0x2A) exits via `ja 0x51F746`.

### Why this matters for the stuck loop

The `%s %s %s %d %d ...` format is plain — only `%`, `s`, `d`, and spaces. In a correct emu:
- `%` is matched by the outer loop (`cmp [esi],0x25`) and jumps in.
- `s`/`d` → bt=0x08 → jt[8] → `inc [esp+0x13]` → loop exits → vararg fetch + conversion.
- Space (0x20) < 0x2A → `ja 0x51F746` taken → exit.

For the loop to get stuck, ECX must be reading bytes whose bt lookup returns 0x01 (F), 0x04 (N), or digit-range — chars not in the format at all. That points at one of:

1. **`mov al, [eax+edx*2]`** (`0x51F6BC`) — ctype lookup. If this returns 0x04 (_DIGIT bit) for non-digit bytes, the digit-accumulation path runs forever, inc'ing ECX past end. The lookup uses `scale=2` with `edx=char` — easy place for a wasm decoder bug if `edx*2` overflows some intermediate.
2. **`mov dl, [eax+0x520210]`** (`0x51F6EA`) — byte-table lookup. `eax = esi - 0x2a` is signed; if the emu treats negative as a huge positive and the cmp earlier was wrong, could index wildly.
3. **`jmp [0x5201EC + edx*4]`** — indirect jump through memory. Emu bug here would dispatch to the wrong `jt[]` entry.

The smoking gun would be: what does `esi` (current char) contain each iteration when stuck? If it's a legitimate `s` but the code branches as if it were `F`, that's #1 or #3.

### Debugging tool: `--trace-at=0xADDR`

Added to `test/run.js`: non-interactive register + top-of-stack dump each time EIP hits addr. Uses `set_bp` under the hood so it fires at block boundaries. Mutually exclusive with `--break`. Dump includes `EAX..EDI` and `[esp..esp+0x14]` as dwords. Example: `--trace-at=0x5196a0 --stuck-after=10000` (bump stuck-after because each hit makes `run()` return with the same EIP, fooling the stuck detector).

### What the game is actually doing

Caller at `0x004583CD` is the serialization wrapper — large on-stack buffer, pushes `0x0054C400` (the `"%s %s %s %d %d ..."` format), calls `0x005196A0`, then `add esp, 0x10c` and `cmp eax, -1`. It's being called ~1 per batch in a repaint/idle loop with identical register state.

Only 4 API calls fire over 20,000 batches after init, so the game is in a busy wait, not polling the OS. Likely candidates:
- Waiting for a flag set by a WM_TIMER/WM_PAINT handler that the emulator isn't delivering
- Waiting for a DirectSound buffer position to advance
- Mouse/keyboard polling via a non-API path (memory-mapped input?)

### Next concrete experiment

Trace the game's main loop driver. Break at the return target `0x004583D2`, walk up to find the enclosing function, then break at its entry. Look for the idle-loop structure: what condition exits it? Cross-reference with `--trace-api` to see which API does fire (4 calls in 20k batches) — those are the polling points and the condition is probably derived from their return values.

## DRS resource files (FIXED)

All 5 DRS files now load:
- **sounds.drs** — opened via CRT `_open`/`_read` path (non-mapped). Fixed by correcting `TEST AL, imm8` decoder bug that caused FTEXT flag false positive.
- **graphics.drs, Terrain.drs, Border.drs, Interfac.drs** — loaded via `CreateFileMappingA` + `MapViewOfFile`.

## Key addresses

| Address | Description |
|---------|-------------|
| 0x0051CD60 | CRT entry point |
| 0x0051F570 | vsprintf/vsnprintf core (current blocker — infinite loop) |
| 0x0051F67C | main format-parser loop (ECX = format cursor) |
| 0x005196A0 | vsprintf wrapper (strlen+call) |
| 0x0054C400 | Example format string: `"%s %s %s %d %d ..."` × many repeats |
| 0x00557900 | CRT ctype table pointer |
| 0x00557B0C | Locale flag (checked at loop top) |
| 0x005201EC | Format-flag-char jump table (9 entries) |
| 0x00520210 | Format-flag-char byte table (78 entries, chars 0x2A..0x77) |
| 0x00520260 | Conversion-char jump table |
| 0x00520290 | Conversion-char byte table |
| 0x0043AE81 | DirectDraw init start |
| 0x0043AEC0 | EnumDisplayModes callback |
| 0x0043B30C | Secondary DDraw init (after mode selection) |
| 0x004F5B98 | DRS resource file loader |
| 0x0046E8E5 | "Open_Mapped_ResFile" error path |
| 0x0046E9A0 | "Reading resfile header" error path |
| 0x00447D26 | "Could not initialize graphics system" error setup |
| 0x00418B84 | Graphics init failure handler |

## API call flow (628 on CLI before stuck)

1. CRT init: GetVersion, HeapCreate, VirtualAlloc × 2 (4MB @ 0x400000, 64KB @ 0x7A8000), GetStartupInfoA, GetStdHandle×3 / GetFileType×3, SetHandleCount, GetACP, GetCPInfo×2, GetStringTypeW, LCMapStringW, MB↔WC conversions
2. GetCommandLineA, GetEnvironmentStringsW, WideCharToMultiByte×2, FreeEnvironmentStringsW, GetModuleFileNameA, GetModuleHandleA "KERNEL32", SetUnhandledExceptionFilter, GetSysColor×2
3. RegCreateKeyExA × 2 (HKCU + HKLM)
4. DRS loading: CreateFileA "sounds.drs" + GetFileType + SetFilePointer + ReadFile + HeapAlloc + SetFilePointer + ReadFile; then CreateFileA+CreateFileMappingA+MapViewOfFile for graphics.drs, Terrain.drs, Border.drs, Interfac.drs (+ LoadLibraryA language.dll)
5. RegQueryValueExA × 5 (game settings)
6. GlobalMemoryStatus, CreateMutexA, GetLastError, ReleaseMutex, GetVersionExA, SystemParametersInfoA × 2, LoadIconA, RegisterClassA, GetSystemMetrics × 2
7. CreateWindowExA "Age of Empires" 640×480, DefWindowProcA×3, LoadCursorA, SetCursor, SetClassLongA
8. **DDraw init:** DirectDrawCreate → EnumDisplayModes → Release → DirectDrawCreate → EnumDisplayModes → SetCooperativeLevel → SetDisplayMode → CreatePalette → SetEntries → CreateClipper → SetHWnd → CreateSurface → Blt → SetPalette → SetClipper → CreateSurface ×N → GetSurfaceDesc → Blt loops → GetCaps
9. **DSound init:** DirectSoundCreate chain → CreateSoundBuffer × many → Lock → (write WAV bytes) → Unlock (sound effects loaded from sounds.drs chunks)
10. RegQueryValueExA (more settings), GetCurrentDirectoryA × 2
11. CreateRectRgn, InvalidateRect × N, DeleteObject, SetEntries (palette), Blt, timeGetTime polling, IsIconic
12. **Stuck:** enters `0x51F570` vsprintf and never returns.
