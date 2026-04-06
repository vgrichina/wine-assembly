# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Game window visible with menu, game loop running (timeGetTime/PeekMessage/GetMessage). Full table init completes — PINBALL.DAT loaded, RCDATA parsed, audio initialized, 4 windows created, 19+ objects constructed. StretchDIBits called but not yet rendered (stub handler). Game loop entered and polling for messages.

## What Works

- PE loading + DLL loading (comctl32.dll, msvcrt.dll)
- DllMain calls succeed for both DLLs
- msvcrt CRT init (TLS, heap, environment, command line, codepage)
- comctl32 class registration (10+ window classes)
- Registry reads/writes from `Software\Microsoft\Plus!\Pinball\SpaceCadet`
- MapVirtualKeyA scan (0x00–0xFF keyboard mapping)
- Window class registration + CreateWindowExA (640x480 main window)
- **WM_CREATE delivered to pinball's game WndProc** (fixed: class table lookup, nested CreateWindowExA)
- **Nested CreateWindowExA**: 4 windows created during init (frame, game, hidden, timer), all with inline WM_CREATE dispatch
- CreatePalette, SelectPalette, RealizePalette — palette stored in WASM memory
- GetDesktopWindow, GetWindowRect, SetCursor
- WaveMix initialization: wavemix.inf loaded via CreateFileA/fopen
- waveOutGetDevCapsA, waveOutGetNumDevs, waveOutOpen, waveOutPrepareHeader — audio device enumeration + init
- **PINBALL.DAT fully loaded** — OpenFile + _hread reads table data, lstrcmpA verifies PARTOUT signature
- **RCDATA table resource loaded** — FindResourceA/LoadResource/LockResource loads embedded table definition
- **Game table objects initialized** — CriticalSection flood (19+ objects × InitializeCriticalSection)
- **Game loop entered** — PeekMessage(PM_REMOVE) + timeGetTime polling + GetMessage loop active
- GetPrivateProfileIntA — reads all game settings from INI
- Menu state set up — CheckMenuItem for 7+ menu items, DeleteMenu, DrawMenuBar
- Data files pre-loaded from EXE directory into virtual filesystem
- **StretchDIBits called** — game attempts to render table bitmap (5 blit regions per frame)
- ShowWindow + UpdateWindow for game window

## Fixes Applied (This Session)

1. **Class table lookup fallback for rotating string buffers** (`09a5-handlers-window.wat`): Pinball uses a 6-slot rotating buffer at 0x010248a8 (256 bytes each, index at [0x1024ea8]) for LoadStringA results. The GUID class name (string ID 167) was registered in one slot, but by the time CreateWindowExA ran, the buffer index had advanced and the slot was overwritten with "Replay Awarded" (string ID 0). Fix: when class_table_lookup fails for a non-first window, use `$last_registered_wndproc` as fallback.

2. **_lread double g2w fix** (`09a-handlers.wat`): _lread handler did `g2w(arg1)` on the buffer address, but `fs_read_file` in JS already does g2w internally. Double conversion wrote data to wrong memory. Also fixed `bytes_read` parameter: was passing WASM address to a function expecting guest address.

3. **_hread implementation** (`09a-handlers.wat`, `api_table.json`): Added `$handle__hread` (identical to `_lread`) — Pinball imports both `_lread` and `_hread` from KERNEL32.

4. **GlobalHandle implementation** (`09a-handlers.wat`): Was a crash stub. Since our GlobalLock returns ptr as-is, GlobalHandle returns the same handle.

5. **CACA0001 nested CreateWindowExA fix** (`09b-dispatch.wat`): The continuation thunk used globals (`createwnd_saved_hwnd`/`createwnd_saved_ret`) that were overwritten by nested CreateWindowExA calls during WM_CREATE. Fixed to pop saved_ret and saved_hwnd from the stack, which naturally supports arbitrary nesting depth.

6. **DestroyWindow main_hwnd promotion** (`09a-handlers.wat`): When destroying main_hwnd, promote next window (main_hwnd+1) instead of setting quit_flag. This handles apps like Pinball that destroy an initial frame window and keep a game window.

## Fixes Applied (Previous Sessions)

1. **CreateWindowExA stack leak** (`09b-dispatch.wat`): CACA0001 continuation thunk wasn't cleaning saved_ret + saved_hwnd (8 bytes) from the stack after WndProc returned.

2. **VFS pre-loading** (`test/run.js`): Companion files from EXE's directory auto-loaded into VFS
3. **OpenFile** (`09a-handlers.wat`): Implemented via `host_fs_create_file` instead of always returning HFILE_ERROR
4. **_lopen, _lread, _llseek, _lclose** (`09a-handlers.wat`): Implemented using host FS imports
5. **GetFileType** (`09a-handlers.wat`): Returns FILE_TYPE_DISK(1) for file handles instead of FILE_TYPE_UNKNOWN(0)
6. **WM_CREATE for all windows** (`09a5-handlers-window.wat`): Check if wndproc is in EXE address range
7. **Class table expanded** (`09c-help.wat`): 16→32 slots
8. **Palette APIs** (`09a-handlers.wat`): CreatePalette, SelectPalette, RealizePalette
9. **WINMM audio APIs** (`09a-handlers.wat`): waveOutGetDevCapsA, waveOutOpen/Close/Write/Reset, mmio*, mci*, sndPlaySoundA
10. **ChangeDisplaySettingsA**: Returns DISP_CHANGE_SUCCESSFUL
11. **Nested CreateWindowExA stack save** (`09a5-handlers-window.wat`): Saves createwnd_saved_hwnd/ret on guest stack
12. **PE headers at image_base**: MZ+PE headers present for CRT startup check

## Current Blocker

**StretchDIBits stub — no table rendering**

The game loop is running and calling StretchDIBits to render the table bitmap, but the handler is a no-op stub that just returns the scan line count. Need to implement StretchDIBits to actually blit DIB data to the renderer.

The game calls StretchDIBits with 5 regions per frame:
- API args: `(hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, lpBits, lpBmi, iUsage, dwRop)` — 13 args stdcall
- The DIB data is in guest memory at `lpBits`, with BITMAPINFO header at `lpBmi`
- Need a `host_gdi_stretch_dib_bits` import similar to `host_gdi_bitblt`

### Next Steps
1. **Implement StretchDIBits**: Create host import that reads BITMAPINFO header + DIB bits from guest memory, converts to RGBA, and blits to the renderer canvas
2. **Handle palette mapping**: The game uses a 256-color palette (SelectPalette/RealizePalette), so the DIB data may use palette indices that need to be resolved

## Architecture Notes

- Pinball is a Win32 app importing from KERNEL32, USER32, GDI32, ADVAPI32, WINMM, COMCTL32, and MSVCRT
- comctl32.dll and msvcrt.dll loaded as real PE DLLs; other DLLs handled via API thunks
- **Game WndProc (0x01007a3e)**: Large message dispatch function. WM_CREATE does table init. Game loop is in WinMain.
- **Frame WndProc (0x01007264)**: Handles WM_PAINT and WM_ERASEBKGND only; destroyed after game window init
- Game uses a custom game loop: tight `timeGetTime` polling + `PeekMessageA(PM_REMOVE)` + GetMessageA
- Table data is in proprietary `PINBALL.DAT` format opened via `OpenFile`/`_hread`
- Table definition also embedded as RCDATA resource in EXE
- Audio via WaveMix library (reads wavemix.inf, uses waveOut* APIs)
- Registry key: `HKCU\Software\Microsoft\Plus!\Pinball\SpaceCadet`
- **Rotating string buffer**: Helper at 0x01003752 uses 6 slots × 256 bytes at 0x010248a8, index at [0x1024ea8]. LoadStringA results are transient — callers must copy before the next call.
- **Init flow**: WinMain → RegisterClassA (frame) → CreateWindowExA (frame 0x10001, temp helper) → RegisterClassA (game, GUID classname) → CreateWindowExA (game 0x10002) → WM_CREATE → full table init → ShowWindow → DestroyWindow(frame) → message loop

## Memory Layout for Palette Storage

- `0x2800`: Palette table (4 entries × 8 bytes: handle + count)
- `0x2830`: Palette data (4 × 1024 bytes, 256 RGBX entries each)
- Handles: 0x000A0001–0x000A0004
