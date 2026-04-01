# Minesweeper (Windows XP)

Classic Minesweeper from Windows XP. 32-bit PE, pure Win32 API with COMCTL32 dependency.

## Binary Info

- **File:** `test/binaries/xp/winmine.exe`
- **Image base:** 0x01000000
- **Entry point:** 0x01003E21 (CRT startup)
- **Sections:** .text (0x3A56), .data (0xB98), .rsrc (0x19160)

## Key Addresses

| Address | Description |
|---------|-------------|
| 0x01003E21 | CRT entry point (WinMainCRTStartup) |
| 0x010021F0 | WinMain |
| 0x01001BC9 | WndProc (registered in WNDCLASS at WinMain+0x6D) |
| 0x01001950 | Window sizing/layout function |
| 0x01001915 | GetSystemMetrics helper (called for window chrome) |
| 0x01002B14 | Post-CreateWindow init |
| 0x01003AB0 | Early init (called from WinMain) |

## Import Table (key entries)

| IAT Address | Function | Notes |
|-------------|----------|-------|
| 0x100111C | GetMenuItemRect | Used in sizing function to detect menu wrap |
| 0x1001118 | MoveWindow | Used in sizing function to resize window |
| 0x1001114 | SetRect | Used after sizing to set invalidation rect |
| 0x1001110 | InvalidateRect | Triggers repaint after resize |
| 0x100115C | CreateWindowExW | Main window creation |
| 0x10010CC | RegisterClassW | |
| 0x10010D4 | LoadMenuW | Menu resource 0x1F4 (500) |
| 0x1001160 | LoadAcceleratorsW | Accelerator table 0x1F5 (501) |
| 0x10010AC | LoadIconW | Icon resource 0x64 (100) |
| 0x100101C | InitCommonControlsEx | COMCTL32 init |
| 0x1001028 | GetLayout | GDI RTL layout support |
| 0x100102C | SetLayout | GDI RTL layout support |
| 0x100104C | SetDIBitsToDevice | Bitmap rendering |

## DLL Dependencies

- **msvcrt.dll** — C runtime (loaded as DLL)
- **USER32.dll** — 23 imports (windowing, messages, menus, dialogs)
- **GDI32.dll** — 15 imports (drawing, DC management, bitmaps)
- **KERNEL32.dll** — 13 imports (resources, strings, module info)
- **ADVAPI32.dll** — 6 imports (registry for settings persistence)
- **COMCTL32.dll** — 1 import (InitCommonControlsEx)
- **SHELL32.dll** — 1 import (ShellAboutW for Help>About)
- **WINMM.dll** — 1 import (PlaySoundW for win/lose sounds)

## Window Sizing Function (0x01001950)

This is the most interesting early code path. Minesweeper computes its window size from the grid dimensions and menu bar height:

1. `mov edi, [0x100111C]` — loads GetMenuItemRect function pointer
2. Calls GetMenuItemRect twice (items 0 and 1), compares `.top` fields to detect menu row wrapping
3. Computes: `width = cols*16 + 24`, `height = rows*16 + 67`
4. Calls GetSystemMetrics (SM_CXFRAME, SM_CYFRAME, SM_CYCAPTION) for window chrome
5. Calls MoveWindow (ESI = `[0x1001118]`) to resize
6. Second pass of GetMenuItemRect to re-check after resize
7. SetRect + InvalidateRect to trigger repaint

## Global Variables (.data section, base 0x01005000)

| Address | Description |
|---------|-------------|
| 0x1005334 | Grid columns |
| 0x1005338 | Grid rows |
| 0x1005B24 | Main window handle (hWnd) |
| 0x1005B28 | Icon handle |
| 0x1005B30 | hInstance |
| 0x1005B34 | Menu bar height adjustment |
| 0x1005B38 | Minimized flag |
| 0x1005B80 | Saved window height |
| 0x1005B88 | Computed window height |
| 0x1005AA0 | Window class name string |
| 0x1005A90 | Window border offset |
| 0x1005A94 | Menu handle |
| 0x10056B0 | Window X position |
| 0x10056B4 | Window Y position |
| 0x10056C4 | Layout flags |
| 0x1005B2C | Computed client width |
| 0x1005B20 | Computed client height |

## Click Handler Flow (0x0100140C)

After WM_LBUTTONDOWN, the click handler:
1. `PtInRect` — checks if click is on smiley button
2. `SetCapture` — captures mouse
3. Enters tight `PeekMessageW` loop at `0x0100148C` filtering for `WM_MOUSEFIRST(0x200)..0x20D`, waiting for `WM_LBUTTONUP` or `WM_MOUSEMOVE`
4. On WM_LBUTTONUP: `ReleaseCapture`, proceeds to reveal logic

## Mine Placement Function (0x010036C7)

Loop places 10 mines (beginner):
- Calls rand wrapper at `0x01003940` (msvcrt `rand()` + `cdq; idiv` for modulo)
- `test byte [ecx+esi+0x1005340], 0x80` — check if cell already has mine
- `or byte [eax], 0x80` — place mine
- `dec [0x1005330]` — decrement mine counter
- Loop until counter reaches 0

## Cell Drawing Function (0x01002646)

```
movsx edx, byte [edx+eax+0x1005340]  ; read cell value (SIB addressing)
and edx, 0x1f                         ; mask to sprite index 0-31
push [0x1005a20+edx*4]                ; dcArray[index] = source DC handle
; ... BitBlt to window DC
```

DC handle array at `0x1005a20`: 16 entries (0x80002..0x80020), one per sprite (empty, 1-8, mine, flag, etc.)

## Status

- **Current:** PASS — window created, smiley face renders correctly inside window
- **Rendering:** `--png` output shows proper window with title bar, Game/Help menu, mine grid, smiley button
- **Known issues:**
  - Grid state (`0x1005340`) never changes from `0x40` (hidden) despite reveal counter decrementing — mine placement and/or reveal byte writes not persisting. Likely an emulation bug in `or byte [mem], imm8` or `and byte [mem], imm8` in the mine placement/reveal functions. All cells render as empty (sprite 0) because `0x40 & 0x1F = 0`.
  - SetROP2 is stubbed (always R2_COPYPEN) — white highlight lines on the 3D border draw gray instead of white

## Progress Log

- GetMenuItemRect: Added handler with RECT fill (items spaced 100px horizontally, top=0, bottom=20). Fixed missing `esp += 20` stdcall cleanup that caused EIP=0x14 crash.
- GetLayout/SetLayout: Added stubs returning 0 (LTR layout). Unblocked the GDI drawing path.
- Window sizing function fully understood — measures menu items to detect wrapping, computes grid-based window size, accounts for window chrome via GetSystemMetrics.
- Multi-window DC support: DC handle now encodes hwnd (hdc = hwnd + 0x40000). Smiley face fixed from drawing at (0,0). Removed $window_dc_hwnd global.
- **PeekMessageA/W**: Fixed to poll `$host_check_input` for input events (was only checking posted queue). Root cause of click not working — Minesweeper's click handler uses a `PeekMessageW` loop to wait for WM_LBUTTONUP, which previously spun forever.
