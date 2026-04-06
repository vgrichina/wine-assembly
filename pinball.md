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

The game window renders with title bar "3D Pinball for Windows - Space Cadet" and menu (Game, Options, Help). The client area shows teal background — the table bitmap (loaded from PINBALL.DAT) needs to be properly blitted. StretchDIBits is being called for sprite rendering but the main table background via BitBlt/CreateDIBitmap path may need work.

### Next Steps
1. **Table bitmap rendering** — Investigate why BitBlt to hwnd=0x10002 shows empty background. The game creates a DIB bitmap (CreateDIBitmap), selects it into a compatible DC, and blits the table. May need CreateDIBitmap or BitBlt improvements.
2. **Sound playback** — WAV files are loaded into memory but waveOutWrite just marks buffers as done. Could add Web Audio API playback.
3. **Input handling** — Mouse/keyboard events need to reach the game's PeekMessageA loop.

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
