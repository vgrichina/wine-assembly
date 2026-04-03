# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Boots, creates window, loads WaveMix config, opens PINBALL.DAT — stuck in msvcrt CriticalSection during fread

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

**Stuck in msvcrt CriticalSection during fread of PINBALL.DAT**

After OpenFile succeeds and the first _lread completes (183 bytes), execution enters msvcrt's internal file I/O code. msvcrt calls EnterCriticalSection/LeaveCriticalSection on CRT-internal critical sections (at 0x011174e4, 0x01117504). The emulator loops at EIP=0x010d6ab8 without making progress — 844 API calls then infinite loop in 200+ batches.

### Likely Cause
msvcrt's CRT file buffering uses per-file CriticalSections. Our CriticalSection implementation may not properly handle:
- OwningThread matching (we return thread ID 1 for all)
- RecursionCount (reentrant locking)
- Or the CRT is spinning waiting for a condition that never becomes true

### Next Steps
1. Debug the CriticalSection loop — check what msvcrt expects from the CS struct fields
2. May need to implement proper CS OwningThread/RecursionCount semantics
3. Once fread works, pinball will parse PINBALL.DAT and call GDI APIs (CreateDIBitmap, StretchDIBits) to render the table

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
