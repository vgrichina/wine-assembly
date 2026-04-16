# Age of Empires (demo) — Progress

**Binary:** `test/binaries/shareware/aoe/aoe_ex/Empires.exe`
**Image base:** 0x00400000
**Data files:** `test/binaries/shareware/aoe/aoe_ex/data/` — sounds.drs, graphics.drs, Terrain.drs, Border.drs, Interfac.drs
**Window:** 640×480 (or 800×600), title "Age of Empires"
**Status (2026-04-16):** DRS files load successfully (sounds.drs via CRT _read, others via MapViewOfFile). DirectDraw init works. Game enters main rendering loop with Lock/Unlock/Blt cycles. Palette rendering (8-bit indexed→RGBA) still needed for visible output.

## What works

- DirectDrawCreate → DD_OK
- EnumDisplayModes with multi-mode callback (640×480×8/16, 800×600×8/16)
- SetCooperativeLevel(hwnd, DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN)
- SetDisplayMode(800, 600, 8)
- CreatePalette + SetEntries (256-color)
- CreateClipper + SetHWnd
- CreateSurface (primary, offscreen)
- Blt (multiple calls for screen clearing/setup)
- GetSurfaceDesc, GetCaps
- Release chain (Surface → Palette → Clipper → RestoreDisplayMode → DDraw)

## DRS resource files (FIXED)

All 5 DRS files now load:
- **sounds.drs** — opened via CRT `_open`/`_read` path (non-mapped). Fixed by correcting `TEST AL, imm8` decoder bug that caused FTEXT flag false positive.
- **graphics.drs, Terrain.drs, Border.drs, Interfac.drs** — loaded via `CreateFileMappingA` + `MapViewOfFile`. Data mapped into guest memory.

## Current blocker: 8-bit palette rendering

Game uses 256-color DDraw surfaces. Surface Lock→write indices→Unlock→Blt path works, but the 8-bit palette indices need to be converted to RGBA for display.

## Key addresses

| Address | Description |
|---------|-------------|
| 0x0051CD60 | CRT entry point |
| 0x0043AE81 | DirectDraw init start |
| 0x0043AEC0 | EnumDisplayModes callback |
| 0x0043B30C | Secondary DDraw init (after mode selection) |
| 0x004F5B98 | DRS resource file loader |
| 0x0046E8E5 | "Open_Mapped_ResFile" error path |
| 0x0046E9A0 | "Reading resfile header" error path |
| 0x00447D26 | "Could not initialize graphics system" error setup |
| 0x00418B84 | Graphics init failure handler |

## API call flow (242 total)

1. CRT init (GetVersion, HeapCreate, VirtualAlloc, string/locale setup)
2. Registry setup (RegCreateKeyExA × 2)
3. DRS file loading (CreateFileA × 5, ReadFile, CreateFileMappingA × 4, MapViewOfFile × 4) — all fail
4. CreateMutexA, window creation (CreateWindowExA "Age of Empires" 640×480)
5. **DDraw init:** DirectDrawCreate → EnumDisplayModes → Release → DirectDrawCreate → EnumDisplayModes → SetCooperativeLevel → SetDisplayMode → CreatePalette → SetEntries → CreateClipper → SetHWnd → CreateSurface → Blt → SetPalette → SetClipper
6. Multiple CreateSurface + Blt cycles (building screen buffers)
7. GetCaps
8. Cleanup: Release all DD objects, RegCloseKey, DestroyWindow
9. "Could not initialize graphics system" MessageBox
10. ExitProcess(0)
