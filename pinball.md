# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Boots, creates window, loads WaveMix config, opens PINBALL.DAT, loads resources (bitmap, message table). Exits with code 0 — init function returns failure before opening PINBALL.DAT for full game data loading.

## What Works

- PE loading + DLL loading (comctl32.dll, msvcrt.dll)
- DllMain calls succeed for both DLLs
- msvcrt CRT init (TLS, heap, environment, command line, codepage)
- comctl32 class registration (10+ window classes)
- Registry reads from `Software\Microsoft\Plus!\Pinball\SpaceCadet`
- MapVirtualKeyA scan (0x00–0xFF keyboard mapping)
- Window class registration + CreateWindowExA (640x480 main window)
- **WM_CREATE delivered to pinball's WndProc** (fixed: was only sent to first window)
- CreatePalette, SelectPalette, RealizePalette — palette stored in WASM memory
- GetDesktopWindow, GetWindowRect, SetCursor
- WaveMix initialization: wavemix.inf loaded via CreateFileA/fopen
- waveOutGetDevCapsA, waveOutGetNumDevs — audio device enumeration
- **OpenFile + _lread: PINBALL.DAT file opened and reading in progress**
- Data files pre-loaded from EXE directory into virtual filesystem

## Fixes Applied This Session

1. **VFS pre-loading** (`test/run.js`): Companion files from EXE's directory auto-loaded into VFS
2. **OpenFile** (`09a-handlers.wat`): Implemented via `host_fs_create_file` instead of always returning HFILE_ERROR
3. **_lopen, _lread, _llseek, _lclose** (`09a-handlers.wat`): Implemented using host FS imports
4. **GetFileType** (`09a-handlers.wat`): Returns FILE_TYPE_DISK(1) for file handles instead of FILE_TYPE_UNKNOWN(0) — msvcrt's fopen needs this
5. **WM_CREATE for all windows** (`09a-handlers.wat`): Changed condition from `next_hwnd == main_hwnd` to check if wndproc is in EXE address range. Fixed bitwise AND bug (`i32.and` used as logical AND).
6. **Class table expanded** (`09c-help.wat`): 16→32 slots. Pinball + comctl32 register 17+ classes, overflowing the old table.
7. **Palette APIs** (`09a-handlers.wat`): CreatePalette, SelectPalette, RealizePalette, GetPaletteEntries, SetPaletteEntries, ResizePalette, GetNearestPaletteIndex, CreateHalftonePalette, GetSystemPaletteEntries, SetSystemPaletteUse — real implementations storing RGBX entries in WASM memory at 0x2830
8. **WINMM audio APIs** (`09a-handlers.wat`): waveOutGetDevCapsA (fills WAVEOUTCAPS), waveOutOpen/Close/Write/Reset/Pause/Restart/PrepareHeader/UnprepareHeader/GetPosition, mmioOpenA/Close/Descend/Read/Ascend, mciSendCommandA, sndPlaySoundA
9. **ChangeDisplaySettingsA**: Returns DISP_CHANGE_SUCCESSFUL

## Current Blocker

**Init function returns failure — app exits before opening PINBALL.DAT for game data**

After processing the message table (RCDATA "PBMSG_FT"), the init function returns. WinMain sees failure and calls exit(0) without entering the message loop. No GetMessage/PeekMessage ever called.

API trace: 1379 calls total. After HeapAlloc (#844, for message table), ~400 CriticalSection calls (msvcrt locale locking during string processing), FreeResource (#1231), then CRT exit cleanup (more CS calls), SetUnhandledExceptionFilter, ExitProcess(0).

### Investigation Status
- CriticalSection ✓ (fixed — proper LockCount/RecursionCount)
- `test ax, imm16` decoder ✓ (was consuming 4 bytes with 0x66 prefix)
- Named resource lookup ✓ (string matching for RCDATA "PBMSG_FT")
- CreateDIBitmap ✓ (implemented, bitmap loads correctly)
- PE headers ✓ (MZ at image_base for CRT startup)
- No unrecognized x86 opcodes in the trace
- lstrcmpA header check passes (PARTOUT signature matches)

### Next Steps
1. Trace the return path from message table loader to WinMain to find what condition fails
2. Check if fopen is called at all (it should be, but CreateFileA never appears after wavemix.inf)
3. May be an issue with msvcrt's _alloc_osfhnd or file descriptor management
4. Could be a wrong return value from GetVersion, ChangeDisplaySettingsA, or similar check

## Memory Layout for Palette Storage

- `0x2800`: Palette table (4 entries × 8 bytes: handle + count)
- `0x2830`: Palette data (4 × 1024 bytes, 256 RGBX entries each)
- Handles: 0x000A0001–0x000A0004

## Architecture Notes

- Pinball is a Win32 app importing from KERNEL32, USER32, GDI32, ADVAPI32, WINMM, COMCTL32, and MSVCRT
- comctl32.dll and msvcrt.dll loaded as real PE DLLs; other DLLs handled via API thunks
- Game uses a custom game loop: tight `timeGetTime` polling + `PeekMessageA`
- Table data is in proprietary `PINBALL.DAT` format opened via `OpenFile`/`_lread`
- Background is `table.bmp` (standard BMP)
- Audio via WaveMix library (reads wavemix.inf, uses waveOut* APIs)
- Registry key: `HKCU\Software\Microsoft\Plus!\Pinball\SpaceCadet`
