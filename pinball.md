# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Game window visible with menu bar (Game/Options/Help). WM_CREATE dispatched to game WndProc, full table init runs (PINBALL.DAT loaded, RCDATA parsed, audio initialized, 4 windows created). Game loop entered (timeGetTime/PeekMessage). Table area renders as blank teal — no GDI painting yet.

## What Works

- PE loading + DLL loading (comctl32.dll, msvcrt.dll)
- DllMain calls succeed for both DLLs
- msvcrt CRT init (TLS, heap, environment, command line, codepage)
- comctl32 class registration (10+ window classes)
- Registry reads from `Software\Microsoft\Plus!\Pinball\SpaceCadet`
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
- **Game table objects initialized** — CriticalSection flood (19 objects × InitializeCriticalSection)
- **Game loop entered** — PeekMessage(PM_REMOVE) + timeGetTime polling loop active
- GetPrivateProfileIntA — reads all game settings from INI
- Menu state set up — CheckMenuItem for 7+ menu items, DeleteMenu, DrawMenuBar
- Data files pre-loaded from EXE directory into virtual filesystem

## Fixes Applied (This Session)

1. **Class table lookup fallback for rotating string buffers** (`09a5-handlers-window.wat`): Pinball uses a 6-slot rotating buffer at 0x010248a8 (256 bytes each, index at [0x1024ea8]) for LoadStringA results. The GUID class name (string ID 167) was registered in one slot, but by the time CreateWindowExA ran, the buffer index had advanced and the slot was overwritten with "Replay Awarded" (string ID 0). The class_table_lookup hash didn't match, so the game WndProc was never associated with the window. Fix: when class_table_lookup fails for a non-first window, scan the class table for an EXE-range WndProc not already used by main_hwnd.

## Fixes Applied (Previous Sessions)

1. **CreateWindowExA stack leak** (`09b-dispatch.wat`): CACA0001 continuation thunk wasn't cleaning saved_ret + saved_hwnd (8 bytes) from the stack after WndProc returned. This caused ESP to drift -8 per CreateWindowExA call, corrupting all subsequent stack reads. After the frame window's WM_CREATE, registers EBX/ESI/EDI and all stack args were shifted, causing the game window's class name to be loaded from string ID 0 ("Replay Awarded") instead of string ID 167 (the GUID).

2. **CreateWindowExA nesting** (`09b-dispatch.wat`): CACA0001 read saved_ret and saved_hwnd from globals that were overwritten by nested CreateWindowExA calls. Fixed to pop them from the stack instead, which naturally supports arbitrary nesting depth.

3. **_lread double g2w** (`09a-handlers.wat`): _lread handler did `g2w(arg1)` before calling `host_fs_read_file`, but the JS import already does `g2w(bufGA)` internally. Double conversion wrote data to wrong memory, causing PINBALL.DAT signature check to fail (empty buffer vs "PARTOUT(4.0)RESOURCE").

4. **_hread implementation** (`09a-handlers.wat`): Added `$handle__hread` (identical to `_lread`) — the game uses _hread for reading the full DAT file after the header check.

5. **VFS pre-loading** (`test/run.js`): Companion files from EXE's directory auto-loaded into VFS
6. **OpenFile** (`09a-handlers.wat`): Implemented via `host_fs_create_file` instead of always returning HFILE_ERROR
7. **_lopen, _lread, _llseek, _lclose** (`09a-handlers.wat`): Implemented using host FS imports
8. **GetFileType** (`09a-handlers.wat`): Returns FILE_TYPE_DISK(1) for file handles instead of FILE_TYPE_UNKNOWN(0) — msvcrt's fopen needs this
9. **WM_CREATE for all windows** (`09a5-handlers-window.wat`): Changed condition from `next_hwnd == main_hwnd` to check if wndproc is in EXE address range. Fixed bitwise AND bug.
10. **Class table expanded** (`09c-help.wat`): 16→32 slots. Pinball + comctl32 register 17+ classes.
11. **Palette APIs** (`09a-handlers.wat`): CreatePalette, SelectPalette, RealizePalette, etc. — real implementations storing RGBX entries in WASM memory at 0x2830
12. **WINMM audio APIs** (`09a-handlers.wat`): waveOutGetDevCapsA, waveOutOpen/Close/Write/Reset, mmioOpenA/Close/Descend/Read/Ascend, mciSendCommandA, sndPlaySoundA
13. **ChangeDisplaySettingsA**: Returns DISP_CHANGE_SUCCESSFUL
14. **Nested CreateWindowExA stack save** (`09a5-handlers-window.wat`): Saves createwnd_saved_hwnd/ret on guest stack before WM_CREATE dispatch so nested CreateWindowExA calls don't corrupt the outer context's return path
15. **PE headers at image_base**: MZ+PE headers present for CRT startup check

## Current Blocker

**Null pointer crash in TPinballTable::NewTimer (0x010153d2)**

After WM_CREATE completes and the game loop starts, the code at 0x010153d2 dereferences `[0x1025658]` (the global TPinballTable pointer) which is NULL. The function:
```
010153d2  mov ecx, [0x1025658]    ; NULL!
010153d8  fild dword [0x1028234]  ; load frame timing
010153de  mov eax, [ecx]          ; vtable → CRASH
010153e0  push ecx
010153e1  fstp dword [esp]        ; float param
010153e4  push 0x3f6              ; timer ID
010153e9  call [eax]              ; virtual call
```

The TPinballTable is created at 0x010145f5 during init (function at 0x010155f2). When it returns NULL, it's stored at `[0x1025658]` and later crashes. Need to investigate why the table object creation (0x010145f5) fails — likely a missing API or incorrect return value during the C++ object construction chain.

### Investigation Path
1. Trace execution through 0x010145f5 (table object factory) to find where it returns NULL
2. Check if a missing API call during object construction causes early return
3. The function calls 0x1013e25 then 0x10145f5 — both need tracing

## Architecture Notes

- Pinball is a Win32 app importing from KERNEL32, USER32, GDI32, ADVAPI32, WINMM, COMCTL32, and MSVCRT
- comctl32.dll and msvcrt.dll loaded as real PE DLLs; other DLLs handled via API thunks
- **Game WndProc (0x01007a3e)**: Large message dispatch function. WM_CREATE does table init and returns normally. Game loop is in WinMain after CreateWindowExA returns.
- **Frame WndProc (0x01007264)**: Handles WM_PAINT and WM_ERASEBKGND only; all other messages → DefWindowProcA
- Game uses a custom game loop: tight `timeGetTime` polling + `PeekMessageA(PM_REMOVE)`, with 2000ms threshold for frame updates
- Table data is in proprietary `PINBALL.DAT` format opened via `OpenFile`/`_hread`
- Table definition also embedded as RCDATA resource in EXE
- Audio via WaveMix library (reads wavemix.inf, uses waveOut* APIs)
- Registry key: `HKCU\Software\Microsoft\Plus!\Pinball\SpaceCadet`
- **Rotating string buffer**: Helper at 0x01003752 uses 6 slots × 256 bytes at 0x010248a8, index at [0x1024ea8]. LoadStringA results are transient — callers must copy before the next call.

## Memory Layout for Palette Storage

- `0x2800`: Palette table (4 entries × 8 bytes: handle + count)
- `0x2830`: Palette data (4 × 1024 bytes, 256 RGBX entries each)
- Handles: 0x000A0001–0x000A0004
