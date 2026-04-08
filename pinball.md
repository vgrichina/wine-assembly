# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Game initializes fully, reaches game loop (PeekMessageA), renders window with title bar and menu. Table bitmap rendering via StretchDIBits needs work. Clean exit (ExitProcess code=0). ~54K API calls across 500 batches.

## What Works

- PE loading + DLL loading (comctl32.dll, msvcrt.dll)
- DllMain calls succeed for both DLLs
- msvcrt CRT init (TLS, heap, environment, command line, codepage)
- comctl32 class registration (10+ window classes)
- Registry reads/writes from `Software\Microsoft\Plus!\Pinball\SpaceCadet`
- MapVirtualKeyA scan (0x00–0xFF keyboard mapping)
- Window class registration + CreateWindowExA (640x480 main window)
- **WM_CREATE delivered to pinball's game WndProc**
- **Nested CreateWindowExA**: 4 windows created during init
- CreatePalette, SelectPalette, RealizePalette — palette stored in WASM memory
- GetDesktopWindow, GetWindowRect, SetCursor
- WaveMix initialization: wavemix.inf loaded via CreateFileA/fopen
- waveOutGetDevCapsA, waveOutGetNumDevs, waveOutOpen, waveOutPrepareHeader — audio device enumeration + init
- **PINBALL.DAT fully loaded** — table data parsed, structures initialized
- **WAV sound files loaded** — mmioOpenA/mmioDescend/mmioRead/mmioAscend/mmioClose fully implemented
- **ShowWindow + UpdateWindow for main game window (hwnd=0x10002)**
- **Game loop reached** — PeekMessageA polling active
- **StretchDIBits rendering** — game draws sprites and table elements
- **Clean exit** — ExitProcess(0) after game loop

## Fixes Applied (This Session — mmio + heap_free guard)

1. **mmioOpenA real implementation** (`09a3-handlers-audio.wat`): Previously returned 0 (failure stub). Now opens WAV files via `host_fs_create_file`, returning a real file handle. Supports MMIO_READ and MMIO_CREATE flags.

2. **mmioDescend real implementation** (`09a3-handlers-audio.wat`): Previously returned MMIOERR_CHUNKNOTFOUND. Now properly parses RIFF/LIST chunk headers, reads 8-byte chunk header (ckid + cksize), handles RIFF/LIST fccType reading, supports MMIO_FINDCHUNK/MMIO_FINDRIFF/MMIO_FINDLIST search flags, fills MMCKINFO struct (ckid, cksize, fccType, dwDataOffset, dwFlags).

3. **mmioRead real implementation** (`09a3-handlers-audio.wat`): Previously returned 0. Now reads bytes via `host_fs_read_file`, returns actual bytes read.

4. **mmioAscend real implementation** (`09a3-handlers-audio.wat`): Previously was a no-op. Now seeks past remaining chunk data (word-aligned) using `host_fs_set_file_pointer`.

5. **mmioClose real implementation** (`09a3-handlers-audio.wat`): Previously was a no-op. Now calls `host_fs_close_handle`.

6. **heap_free guard for non-heap addresses** (`10-helpers.wat`): The root cause of the previous crash (HeapReAlloc with corrupted pointer 0x2c2c2c28). msvcrt's Small Block Heap (sbh) manages small allocations (<1KB) internally. When sbh-managed blocks were freed through our HeapFree thunk, `heap_free` would add these foreign addresses (below 0x01D12000) to our free list, corrupting it. Later `heap_alloc` would return these non-heap addresses, leading to cascading corruption. Fix: `heap_free` now silently ignores addresses below `0x01D12000` (our heap base).

7. **msvcrt sbh_threshold patch** (`dll-loader.js`): After DllMain, finds `_set_sbh_threshold` export in msvcrt, extracts `__sbh_threshold` variable address from its code, and sets it to 0 to prevent new sbh allocations. Combined with the heap_free guard, this prevents all sbh-related corruption.

## Previous Fixes (Summary)

- _lread/_hread double g2w fix
- _initterm double g2w fix
- SEH trylevel update double g2w fix
- CACA0001 nested CreateWindowExA stack-based return
- DestroyWindow main_hwnd promotion
- CREATESTRUCT address fix for non-0x400000 imageBase
- StretchDIBits implementation (host import + JS renderer)
- VFS pre-loading of companion files
- Class table expanded (16→32 slots)
- Palette APIs, WINMM audio APIs

## Current State

Title screen renders correctly (table bitmap, palette, menu chrome) in both CLI and browser. F2 (New Game) is received and game state advances (1 ball → 2 balls in score panel), but no physics/animation: ball can't bounce because the wall collision data fails to load for 4 visuals.

Blocker: **`# walls doesn't match data size`** fires 4× during PINBALL.DAT loading from a `loader_query_visual()` context. File reads return correct byte counts — the bug is somewhere subtler (struct size mismatch, alignment, or arithmetic on values read from the file).

### Version-mismatch hypothesis DISPROVED (2026-04-08)

Staged the original Microsoft Plus! 95 (1996) version under `test/binaries/pinball-plus95/` from `https://archive.org/details/SpaceCadet_Plus95`. This is a fully matched 1996 exe + DAT pair (different content from the XP set: PINBALL.EXE 351,744 vs 281,088, PINBALL.DAT same 928,700 size but different bytes). After implementing trivial stubs for `GetProcessAffinityMask` and `SetThreadAffinityMask` (Plus! 95's older statically-linked CRT calls them during init), the Plus! 95 build runs and **hits the exact same `# walls doesn't match data size` error from `loader_query_visual()`** — 5 occurrences instead of XP's 4.

**Conclusion:** Two independent Microsoft pinball binaries (1996 and 2008), each with their own matched DAT, fail in the same wall-loader. The bug is in our emulator, not in any version skew. The previous "tags 407/408 unhandled" theory is wrong — Plus! 95 binary almost certainly handles different tag ranges than XP's, yet still fails. Focus future investigation on emulator-side bugs in the FPU path or integer arithmetic used by the wall sub-loader at `0x01009349` (XP) / equivalent in Plus! 95.

### msvcrt `floor` traced (this session)

Hand-decoded `msvcrt.dll!floor` (file 0x2c7a1, RVA 0x2b7a1, default load 0x7802b7a1) — the disasm tool was mangling FPU bytes so I read raw bytes:

- `floor()` prologue: saves FPU CW, calls a helper that does `fnstcw + or RC=01 + fldcw` (sets round-down mode)
- Loads input via `fld qword [ebp+8]`, checks high word for NaN/Inf via `and ax, 0x7ff0; cmp ax, 0x7ff0`
- Normal path: `call 0x7802e20e` — and **this helper is exactly**:
  ```
  7802e20e  55              push ebp
  7802e20f  8b ec           mov ebp, esp
  7802e211  51 51           push ecx; push ecx     ; reserve [ebp-8]
  7802e213  dd 45 08        fld qword [ebp+8]
  7802e216  d9 fc           frndint                ; ← rounds per current CW
  7802e218  dd 5d f8        fstp qword [ebp-8]
  7802e21b  dd 45 f8        fld qword [ebp-8]
  7802e21e  c9              leave
  7802e21f  c3              ret
  ```

So `floor()` **does** depend on `frndint` honoring the FPU control word's RC bits — which is exactly the bug I fixed in `06-fpu.wat`.

Verified the fix is being exercised: instrumented `$fpu_round` with `host_log_i32` to log `(fpu_cw, value*1000)`. Saw consistent CW = `0x173F` (RC = 01 = round-down) and many distinct values flowing through. All tag-range floats appearing in `floor` inputs are exact integers: 401.0, 402.0, 403.0, 404.0, 405.0, 406.0, **407.0**, **408.0**.

**New mystery**: the wall sub-loader at `0x01009349` only handles tags `0x191..0x196` (401..406). Tags 407 and 408 fall through the `dec eax` chain to the unknown-tag error path at `0x01009478`. But:
- 407 appears in `floor` inputs as early as batch ~752 (before the first wall error at batch 755)
- 4 wall errors fire total but values 401-407 appear repeatedly throughout the run
- So either 407 is being processed by a *different* function (one of the 44 `floor` call sites in pinball.exe, not just the wall sub-loader), or our pinball.exe simply doesn't handle tags 407/408 at all and the failing visuals contain them

The fix to `frndint` is **correct** but **does not** resolve pinball — `floor` was already working correctly in our emulator for integer-valued floats (which it produces correctly with any rounding mode). The wall errors have a different root cause: probably pinball.exe + PINBALL.DAT version mismatch where the data uses tags 407/408 not in the binary's switch table, OR there's a different code path that handles 407+ via a function I haven't yet identified.

### FPU `frndint` correctness fix (this session)

While investigating the wall hypothesis, found and fixed a real x87 bug in `src/06-fpu.wat`: `frndint` (`D9 FC`) was hardcoded to `f64.nearest`, ignoring the FPU control word's RC bits. Added a `$fpu_round` helper that switches on `(fpu_cw >> 10) & 3` → `f64.nearest` / `f64.floor` / `f64.ceil` / `f64.trunc`, and routed `frndint` through it. **This is a correctness fix but did NOT resolve the pinball wall errors** — msvcrt's `floor()` evidently doesn't reach `frndint` in our run, so the wall-decode failure has another root cause (still TBD; see below). `fistp` paths still use `i32.trunc_sat_f64_s` unconditionally; that's correct for `_ftol` (which sets RC=11 truncate before calling) but wrong for direct `fist`/`fistp` from generic code. Left for a follow-up.

### Investigation so far (wall validation)

- All 4 MessageBoxA calls share return address `0x01008fd2` → single error-reporter helper at `0x01008f7a`. The helper does `or eax, -1` before returning, so it always returns -1 to its caller.
- Disasm of helper confirms it takes `(msg_id, caption_id)`, looks up text/caption pointers in a table at `0x010235f8` (entries `{key, ptr}` terminated by negative key). Caption=0x12 maps to "loader_query_visual()".
- Disasm of `loader::query_visual` at `0x0100950c`: it's a switch on visual-tag values read as 16-bit words from `[esi]`. Cases for tags 100, 300, 304, 400, 406. The case for **tag 400 (`0x190` = RECTLIST)** is the only place that pushes `(msg_id=0xe, caption=0x12)`:
  ```
  010095eb  lea eax, [edi+0x14]      ; &visual->walls
  010095ee  push eax
  010095ef  movsx eax, word [esi]    ; sub-visual index
  010095f2  push eax
  010095f3  call 0x1009349           ; sub-loader
  010095f8  test eax, eax
  010095fa  jz .ok
  01009600  push 0x12; push 0x0e     ; "# walls doesn't match data size"
  01009604  call 0x1008f7a
  ```
- **Sub-loader `0x01009349`** (~250 bytes): Loads two group-data blobs by index — type-0 (must start with `word 0x190`) and type-0xb (a list of records). Each record's tag is decoded as: `fld dword [esi]; sub esp,8; fstp qword [esp]; call [floor]; call _ftol; movsx eax, ax`. So tags are stored as **single-precision floats** (e.g. 401.0..406.0) and converted via msvcrt's `floor` + `_ftol`. Switch jumps on tags `0x191..0x196`; unknown → inner error path which **also** calls the same helper (caption 0x14, msg_id varies).
- **Mystery**: Trace shows exactly **4** MessageBoxA calls, all caption=0x010017ec, all msg_id=0xe (text "# walls doesn't match data size"). Inner error paths in `0x01009349` should fire MessageBox with caption=0x14 BEFORE the outer fires with 0x12, but no such inner messages are observed. So either: (a) the inner function returns -1 via some path I haven't found that doesn't fire MessageBox; (b) the table lookup degenerates and the helper's caption arg actually maps both 0x12 and 0x14 to the same pointer 0x010017ec, hiding the inner errors as duplicates of the outer text — but text is selected by msg_id and only id=0xe gives "walls doesn't match"; (c) some path I'm not seeing.
- `--break` is unreliable here: it only fires at WASM batch boundaries, so most in-block addresses report "0 hits" even when executed. This invalidated my earlier confidence in "inner error sites are not hit". Need a different debugging mechanism (host_log injection or deeper instrumentation) to actually trace the path through `0x01009349`.
- EBP chain (12 deep) from each MessageBoxA call shows 3 distinct loader entry points hitting it:
  - `0x01017c6f` — 1× failure (first)
  - `0x010190b5` — 3× failures, via `0x0101c59f` / `0x01019bd7` / `0x0101a2d1` (different visual-loader sub-paths)
  - All under `0x0101aaf5` → `0x01015426` (loader-root, likely `loader::loadfrom`)
- Tooling improvement: `test/run.js` `--trace-api` now prints MessageBoxA return address + 12-deep EBP frame chain. This is what made it possible to localize the failures in one run.

### Next Steps
1. **Trace the actual path through `0x01009349`** — `--break` is unreliable for in-block addresses; need either (a) `$host_log_i32` injection at the inner function's tag-switch, (b) a temporary x87-op trace in `06-fpu.wat` to log values returned by `floor`/`_ftol` during PINBALL.DAT loading, or (c) a `--trace-block` mode in run.js that logs every block-decode boundary by EIP.
2. **Verify `getGroup_data` returns the right pointer** for the failing indices — could be a PINBALL.DAT parsing issue rather than FPU. The data format ("PARTOUT(4.0)RESOURCE.3D-Pinball" header) needs to be cross-referenced with the SpaceCadetPinball decomp.
3. **Cross-reference msvcrt `floor` disassembly** — the disasm tool mangles FPU opcodes; need to hand-decode the bytes at `msvcrt.dll!floor` (file offset 0x2c7a1, RVA 0x2b7a1, runtime VA depends on load) to confirm whether it actually uses `frndint` or some other mechanism. `_ftol` is already confirmed to be `fstcw + or RC=11 + fldcw + fistp m64 + restore`, which works correctly with our truncate-always `fistp`.
2. **STUCK detection default** — Pinball has a long row-by-row blit loop at `0x010048c2` (~0xCB × 0x18A bytes) that false-trips `--stuck-after=10`. Need `--stuck-after=2000` and ~5000 batches to reach the message loop now. Bump default, or count instructions instead of batches.
3. **Perf regression?** — `pinball.md` previously said "~54K API calls across 500 batches"; current run needs ~5000 batches for ~45K calls. Worth investigating whether init genuinely got longer or block-cache/decoder regressed.
4. **Sound playback** — WAV files loaded but `waveOutWrite` just marks buffers done. Could add Web Audio playback.
5. **Input handling** — Mouse/keyboard events past F2 need to reach the game's PeekMessageA loop reliably.

## Architecture Notes

- Pinball imports from KERNEL32, USER32, GDI32, ADVAPI32, WINMM, COMCTL32, MSVCRT
- comctl32.dll and msvcrt.dll loaded as real PE DLLs; other DLLs handled via API thunks
- **Game WndProc (0x01007a3e)**: Large message dispatch. WM_CREATE does table init.
- Game uses PeekMessageA(PM_REMOVE) + timeGetTime polling game loop
- Table data in proprietary PINBALL.DAT format (928KB)
- Audio via WaveMix library (wavemix.inf config, waveOut* APIs, mmio* for WAV loading)
- Registry key: `HKCU\Software\Microsoft\Plus!\Pinball\SpaceCadet`
- **Init flow**: WinMain → RegisterClassA → CreateWindowExA (frame) → CreateWindowExA (game) → WM_CREATE → table init → PINBALL.DAT load → WAV load → ShowWindow → DestroyWindow(frame) → PeekMessageA game loop

## Memory Layout for Palette Storage

- `0x2800`: Palette table (4 entries × 8 bytes: handle + count)
- `0x2830`: Palette data (4 × 1024 bytes, 256 RGBX entries each)
- Handles: 0x000A0001–0x000A0004
