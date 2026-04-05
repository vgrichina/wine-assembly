# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Game loop running — PeekMessage/timeGetTime loop active, 28K+ API calls per 50 batches. Screen renders black (no GDI painting yet). WM_CLOSE exits cleanly.

## What Works

- PE loading + DLL loading (comctl32.dll, msvcrt.dll)
- DllMain calls succeed for both DLLs
- msvcrt CRT init (TLS, heap, environment, command line, codepage)
- comctl32 class registration (10+ window classes)
- Registry reads from `Software\Microsoft\Plus!\Pinball\SpaceCadet`
- MapVirtualKeyA scan (0x00–0xFF keyboard mapping)
- Window class registration + CreateWindowExA (640x480 main window)
- **WM_CREATE delivered to pinball's WndProc** (fixed: was only sent to first window)
- **Nested CreateWindowExA**: 4 windows created during init (frame, game, hidden, timer), all with inline WM_CREATE dispatch
- CreatePalette, SelectPalette, RealizePalette — palette stored in WASM memory
- GetDesktopWindow, GetWindowRect, SetCursor
- WaveMix initialization: wavemix.inf loaded via CreateFileA/fopen
- waveOutGetDevCapsA, waveOutGetNumDevs — audio device enumeration
- **PINBALL.DAT fully loaded** — OpenFile + _lread reads table data, lstrcmpA verifies PARTOUT signature
- **Game table objects initialized** — CriticalSection flood (19 objects × InitializeCriticalSection)
- **Game loop entered** — PeekMessage(PM_REMOVE) + timeGetTime polling loop active
- GetPrivateProfileIntA — reads all game settings from INI
- Data files pre-loaded from EXE directory into virtual filesystem

## Fixes Applied (Previous Sessions)

1. **VFS pre-loading** (`test/run.js`): Companion files from EXE's directory auto-loaded into VFS
2. **OpenFile** (`09a-handlers.wat`): Implemented via `host_fs_create_file` instead of always returning HFILE_ERROR
3. **_lopen, _lread, _llseek, _lclose** (`09a-handlers.wat`): Implemented using host FS imports
4. **GetFileType** (`09a-handlers.wat`): Returns FILE_TYPE_DISK(1) for file handles instead of FILE_TYPE_UNKNOWN(0) — msvcrt's fopen needs this
5. **WM_CREATE for all windows** (`09a5-handlers-window.wat`): Changed condition from `next_hwnd == main_hwnd` to check if wndproc is in EXE address range. Fixed bitwise AND bug.
6. **Class table expanded** (`09c-help.wat`): 16→32 slots. Pinball + comctl32 register 17+ classes.
7. **Palette APIs** (`09a-handlers.wat`): CreatePalette, SelectPalette, RealizePalette, etc. — real implementations storing RGBX entries in WASM memory at 0x2830
8. **WINMM audio APIs** (`09a-handlers.wat`): waveOutGetDevCapsA, waveOutOpen/Close/Write/Reset, mmioOpenA/Close/Descend/Read/Ascend, mciSendCommandA, sndPlaySoundA
9. **ChangeDisplaySettingsA**: Returns DISP_CHANGE_SUCCESSFUL
10. **Nested CreateWindowExA stack save** (`09a5-handlers-window.wat`): Saves createwnd_saved_hwnd/ret on guest stack before WM_CREATE dispatch so nested CreateWindowExA calls don't corrupt the outer context's return path
11. **PE headers at image_base**: MZ+PE headers present for CRT startup check

## Current Blocker

**Black screen — no GDI rendering**

The game loop is running (PeekMessage/timeGetTime) but nothing is painted. The WndProc's WM_CREATE handler enters the game loop directly (it never returns from WM_CREATE — the combined WndProc/game-loop function stays in the PeekMessage loop).

Key observations:
- No WM_PAINT messages are being generated (no InvalidateRect/UpdateWindow calls seen)
- ShowWindow was called on the frame window (0x10001) but not on the game window (0x10002)
- SetFocus currently returns previous focus hwnd without dispatching WM_SETFOCUS
- The `[0x1024fec]` focus flag is never set (controls PeekMessage vs GetMessage path)
- Game DOES enter the PeekMessage path despite [0x1024fec]=0, suggesting the game loop is entered from WM_CREATE before the flag check matters

### Next Steps
1. **Rendering**: Investigate why no GDI draw calls (BitBlt, StretchBlt) appear — may need WM_PAINT delivery
2. **SetFocus + WM_SETFOCUS**: Implement proper WM_SETFOCUS dispatch so [0x1024fec] gets set
3. **ShowWindow for game window**: Check if ShowWindow(game_hwnd) is ever called, and ensure it triggers WM_PAINT
4. **Table rendering**: The table bitmap (table.bmp) needs to be rendered via GDI calls from the game loop

## Architecture Notes

- Pinball is a Win32 app importing from KERNEL32, USER32, GDI32, ADVAPI32, WINMM, COMCTL32, and MSVCRT
- comctl32.dll and msvcrt.dll loaded as real PE DLLs; other DLLs handled via API thunks
- **Combined WndProc/game-loop**: The WndProc at 0x1007a3e is a massive function containing both message handling and the main game loop. WM_CREATE handler falls through into the game loop (never returns via ret 0x10)
- Game uses a custom game loop: tight `timeGetTime` polling + `PeekMessageA(PM_REMOVE)`
- Table data is in proprietary `PINBALL.DAT` format opened via `OpenFile`/`_lread`
- Background is `table.bmp` (standard BMP)
- Audio via WaveMix library (reads wavemix.inf, uses waveOut* APIs)
- Registry key: `HKCU\Software\Microsoft\Plus!\Pinball\SpaceCadet`

## Memory Layout for Palette Storage

- `0x2800`: Palette table (4 entries × 8 bytes: handle + count)
- `0x2830`: Palette data (4 × 1024 bytes, 256 RGBX entries each)
- Handles: 0x000A0001–0x000A0004
