# Space Cadet Pinball — Progress

**Binary:** `test/binaries/pinball/pinball.exe`
**DLLs:** comctl32.dll, msvcrt.dll
**Window:** 640x480, title "3D Pinball for Windows - Space Cadet"
**Status:** Init reaches deep into table data parsing and bitmap loading (25778 API calls). PINBALL.DAT signature verified, file read loop active, WaveMix audio buffers allocated. Crashes in msvcrt heap manager during bitmap decompression — HeapReAlloc receives corrupted pointer (0x2c2c2c28), indicating memory corruption during table parsing. Previous blocker (double g2w in _lread causing file data to be written to wrong memory) is fixed.

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
- **PINBALL.DAT signature verified** — lstrcmpA("PARTOUT(4.0)RESOURCE") succeeds, file parsing begins
- **Table data parsing active** — hundreds of _lread/_hread calls reading structure data from PINBALL.DAT
- GetPrivateProfileIntA — reads all game settings from INI
- Menu state set up — CheckMenuItem for 7+ menu items, DeleteMenu, DrawMenuBar
- Data files pre-loaded from EXE directory into virtual filesystem
- **StretchDIBits implemented** — host import + WAT handler + JS renderer (1/4/8/24/32-bit DIB, palette support, scaling)
- ShowWindow + UpdateWindow for game window
- **4 windows created**: frame (0x10001), game (0x10002), hidden (0x10003), timer (0x10004)
- **Nested CreateWindowExA fully working** — CACA0001 stack-based return supports arbitrary nesting depth

## Fixes Applied (This Session — g2w Double Conversion)

10. **_lread double g2w fix** (`09a-handlers.wat`): The _lread handler called `$g2w(arg1)` on the buffer address before passing it to `$host_fs_read_file`, but the JS `fs_read_file` already does `g2w(bufGA)` internally. Double conversion wrote PINBALL.DAT data to the wrong WASM address, causing lstrcmpA signature check ("PARTOUT(4.0)RESOURCE") to fail — file buffer contained uninitialized stack data instead. Also fixed `$bytes_read_wa` parameter: was passing WASM address to `gs32()` which does its own g2w.

11. **_initterm double g2w fix** (`09a-handlers.wat`, `09b-dispatch.wat`): `$gl32(call $g2w (initterm_ptr))` — `$gl32` already calls g2w internally, so the explicit g2w was a double conversion. Fixed in both the initial _initterm handler and the CACA0003 continuation.

12. **GetDiskFreeSpaceA double g2w fix** (`09a-handlers.wat`): `$gs32(call $g2w (arg))` — `$gs32` already calls g2w, so the wrapper g2w was double-converting the output pointer addresses.

13. **SEH trylevel update double g2w fix** (`11-seh.wat`): `$gs32(call $g2w (frame_ebp - 4))` — same pattern, `$gs32` does its own g2w.

14. **_hread implementation** (`09a-handlers.wat`, `api_table.json`): Added `$handle__hread` (API #938, identical to _lread). Pinball's table loader uses _hread for bulk data reads from PINBALL.DAT.

15. **GlobalHandle implementation** (`09a-handlers.wat`): Was a crash_unimplemented stub. Since our GlobalLock returns ptr as-is, GlobalHandle returns the same handle. Called by WaveMix during audio buffer management.

## Fixes Applied (Previous Session — Window Creation)

1. **Class table lookup fallback for rotating string buffers** (`09a5-handlers-window.wat`): Pinball uses a 6-slot rotating buffer at 0x010248a8 (256 bytes each, index at [0x1024ea8]) for LoadStringA results. The GUID class name (string ID 167) was registered in one slot, but by the time CreateWindowExA ran, the buffer index had advanced and the slot was overwritten with "Replay Awarded" (string ID 0). Fix: when class_table_lookup fails for a non-first window, use `$last_registered_wndproc` as fallback.

2. **_lread double g2w fix** (`09a-handlers.wat`): _lread handler did `g2w(arg1)` on the buffer address, but `fs_read_file` in JS already does g2w internally. Double conversion wrote data to wrong memory. Also fixed `bytes_read` parameter: was passing WASM address to a function expecting guest address.

3. **_hread implementation** (`09a-handlers.wat`, `api_table.json`): Added `$handle__hread` (identical to `_lread`) — Pinball imports both `_lread` and `_hread` from KERNEL32.

4. **GlobalHandle implementation** (`09a-handlers.wat`): Was a crash stub. Since our GlobalLock returns ptr as-is, GlobalHandle returns the same handle.

5. **CACA0001 nested CreateWindowExA fix** (`09b-dispatch.wat`): The continuation thunk used globals (`createwnd_saved_hwnd`/`createwnd_saved_ret`) that were overwritten by nested CreateWindowExA calls during WM_CREATE. Fixed to pop saved_ret and saved_hwnd from the stack, which naturally supports arbitrary nesting depth.

6. **DestroyWindow main_hwnd promotion** (`09a-handlers.wat`): When destroying main_hwnd, promote next window (main_hwnd+1) instead of setting quit_flag. This handles apps like Pinball that destroy an initial frame window and keep a game window.

7. **CREATESTRUCT address fix for non-0x400000 imageBase** (`09a5-handlers-window.wat`, `09b-dispatch.wat`, `09a-handlers.wat`): The CREATESTRUCT scratch area was hardcoded at guest address 0x400100, which is only valid for the default imageBase of 0x400000. For pinball (imageBase=0x01000000), g2w(0x400100) underflows, causing the CREATESTRUCT to be written to GUEST_BASE (offset 0) instead. All references changed to `image_base + 0x100` (in the DOS header area, safe to overwrite after PE loading).

8. **CACA0001 stack-based return** (`09b-dispatch.wat`): The CreateWindowExA continuation thunk was reading hwnd and return address from globals (`$createwnd_saved_hwnd`, `$createwnd_saved_ret`), which were overwritten by nested CreateWindowExA calls. Fixed to pop saved_ret and saved_hwnd from the guest stack, matching the push order in `handle_CreateWindowExA`. This fixes the return value and resume address for all CreateWindowExA calls.

9. **StretchDIBits implementation** (`01-header.wat`, `09a-handlers.wat`, `host-imports.js`): Added `host_gdi_stretch_dib_bits` import with full JS implementation. Reads BITMAPINFO header + DIB bits from guest memory, handles 1/4/8/24/32-bit palette-indexed and truecolor formats, and blits to the renderer canvas with scaling via drawImage.

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

**Memory corruption during bitmap/table data loading — HeapReAlloc gets corrupted pointer**

After fixing the double g2w bugs, the game now parses PINBALL.DAT successfully (signature check passes, 25778 API calls). The table loader reads hundreds of structures, allocates bitmap memory (HeapAlloc 0x1010-byte chunks), and copies pixel data. But at API #25778, msvcrt's HeapReAlloc receives a corrupted pointer (0x2c2c2c28 — ASCII ",,,,") as the block to reallocate. The new size (0x85ebe360) is also impossibly large.

The corruption pattern (0x2c = ASCII comma) suggests data from the .DAT file is being written over heap metadata. This could be caused by:
- An _hread/\_lread reading into the wrong address (another double g2w issue)
- A buffer overflow in the bitmap copy loop at 0x010048c2 (byte-by-byte row copy)
- Incorrect heap block sizes causing adjacent heap metadata to be overwritten

### Next Steps
1. **Trace the corruption source**: Watch the memory at the corrupted pointer address to find when it gets overwritten with 0x2c2c2c2c. The corruption likely happens during one of the _hread calls reading table structure data.
2. **StretchDIBits is implemented** — ready to render once the game reaches the game loop.

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
