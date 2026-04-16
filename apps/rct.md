# RollerCoaster Tycoon — Progress

**Binary:** `test/binaries/shareware/rct/English/RCT.exe`
**Image base:** 0x00400000
**Data files:** `test/binaries/shareware/rct/Data/` — CSG1.DAT, CSG1i.DAT, CSS*.DAT, etc.
**Window:** Fullscreen 640x480 8bpp (Chris Sawyer's custom engine)
**Status (2026-04-16):** Game starts, all data files load, scenario index loads, DD surfaces created. Game immediately quits because WM_ACTIVATEAPP hasn't been delivered yet — game checks "app active" flag in its first tick, finds it false, exits with "Unable to start game in a minimized state". Screen is black: palette is grayscale ramp, game never calls SetEntries because it quits before reaching the title sequence.

## What works

- CRT startup, registry, file system setup
- DirectDraw: DirectDrawCreate, EnumDisplayModes, SetCooperativeLevel, SetDisplayMode(640,480,8), CreateSurface (primary + 2 offscreen), CreateClipper, CreatePalette, SetPalette, Lock/Unlock
- DirectPlay: DirectPlayEnumerate (stub)
- DirectInput: CreateDevice (keyboard + mouse), SetDataFormat, GetDeviceState, SetCooperativeLevel, Acquire
- VFS: All data files load via root-relative paths (`\Data\CSG1.DAT`). Sibling dirs (Data/, Scenarios/, Saved Games/) mapped from parent.
- Registry: Demo key `HKLM\Software\Fish Technology Group\RollerCoaster Tycoon Demo Setup` with Path=`C:\`
- Scenario loading: SC.IDX index + 9 .SC4 scenario files enumerated via FindFirstFile(`\Scenarios\*.SC4`)
- CSG1.DAT memory-mapped via MapViewOfFile, CSG1I.DAT index processed
- Rendering pipeline: dx_present → SetDIBitsToDevice 640x480 8bpp with palette conversion (fires but palette is grayscale)
- Custom cursors loaded from PE resources (20+ LoadCursorA calls)
- GAME.CFG read/write
- Message loop: PeekMessage/TranslateMessage/DispatchMessage (runs after PostQuitMessage because PeekMessageA doesn't deliver WM_QUIT)

## Current blocker: WM_ACTIVATEAPP timing

The game calls PostQuitMessage (exits) on its **first game tick** — before PeekMessage ever delivers WM_ACTIVATEAPP. The exit message at 0x568960 says "Unable to start game in a minimized state", meaning the WndProc never processed WM_ACTIVATEAPP and the game's "app active" flag stayed false.

**Root cause:** Our CreateWindowExA sends WM_CREATE synchronously, but WM_ACTIVATEAPP/WM_ACTIVATE are deferred until the first PeekMessage/GetMessage call (phase-based delivery). RCT's init code runs between CreateWindowExA and the first PeekMessage, checking the active state during that window. On real Windows, WM_ACTIVATEAPP arrives during or immediately after CreateWindowEx.

**Call chain:** 0x004010FC → 0x438248 (main tick) → checks active flag → 0x555AB8 (decompress exit msg + quit) → 0x555B75 (write GAME.CFG + PostQuitMessage)

**Fix:** Deliver WM_ACTIVATEAPP and WM_ACTIVATE synchronously during CreateWindowExA (after WM_CREATE returns via CACA0001), or via the CBT hook continuation (CACA0002), so the WndProc sets its "active" flag before the game's main tick runs.

## Secondary issue: 8bpp palette

Once the activation fix lets the game run past init, the palette still needs fixing:
- GetSystemPaletteEntries currently zeros the buffer — should return Win98 standard 20 system colors
- The game creates palette with system colors from GetSystemPaletteEntries (entries 0-9 and 246-255), middle entries stay as grayscale ramp
- The game will call IDirectDrawPalette::SetEntries to load the real palette from CSG data during the title sequence — COM dispatch is confirmed working for palette methods
- dx_present at 0xAD40 builds BITMAPINFO with palette from `$dx_primary_pal_wa` and calls host SetDIBitsToDevice

## Key addresses

| Address | Description |
|---------|-------------|
| 0x00403C7D | WndProc |
| 0x00403B2E | PeekMessage-based message check (called from main loop) |
| 0x004010FC | Main function: calls init check, game init, game tick loop |
| 0x00438248 | Main game tick function |
| 0x00555AB8 | Quit wrapper: decompresses exit msg to 0x568720/0x568960, calls 0x555B75 |
| 0x00555B75 | Quit: call 0x452345 (write GAME.CFG), call 0x4045AD (PostQuitMessage) |
| 0x008FA065 | CSG1I index rebase loop |
| 0x00458720 | CSG data decompression function |
| 0x00568960 | Exit message string buffer ("Unable to start game in a minimized state") |
| 0x00560194 | Game exit state flag (set to 1 by quit wrapper) |
| 0x00560198 | Game exit state flag (set to 0 by quit wrapper) |

## DirectX usage

RCT uses DirectDraw for display mode selection and surface management, but its rendering is custom x86 asm blitting to the DD surface:
- **DirectDraw** — SetDisplayMode(640,480,8), CreateSurface (primary+2 offscreen), Lock/Unlock, palette, SetDIBitsToDevice for presentation
- **DirectSound** — sound effects (CSS*.DAT sound banks)
- **DirectInput** — keyboard and mouse via GetDeviceState
- **DirectPlay** — multiplayer enumeration (stub)

## COM objects

| Guest addr | Slot | Type | Notes |
|-----------|------|------|-------|
| 0x083e0000 | 0 | DDraw | Main DirectDraw object |
| 0x083e0008 | 1 | DInput | DirectInput object |
| 0x083e0010 | 2 | DIDevice | Keyboard |
| 0x083e0018 | 3 | DIDevice | Mouse |
| 0x083e0020 | 4 | DDSurface | Primary (640x480x8) |
| 0x083e0028 | 5 | DDClipper | Window clipper |
| 0x083e0030 | 6 | DDPalette | 256-entry palette |
| 0x083e0038 | 7 | DDSurface | Offscreen 1 (icon bitmap) |
| 0x083e0040 | 8 | DDSurface | Offscreen 2 (game buffer) |

## Next steps

1. **Fix WM_ACTIVATEAPP timing** — deliver activation messages synchronously during CreateWindowExA so the WndProc sets its active flag before the game's first tick
2. **Fix GetSystemPaletteEntries** — return standard Win98 20 system colors instead of zeros
3. **Verify palette update** — once the game runs past init, confirm SetEntries is called and palette updates work
4. **Investigate demo timeout** — the demo version may have a time-based exit check
