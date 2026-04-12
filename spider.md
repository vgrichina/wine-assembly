# Spider Solitaire (SPIDER.EXE) — Plus! 98

Binary: `test/binaries/plus98/SPIDER.EXE`

## Status (2026-04-11)

Game is fully playable. Window maximizes to full screen (640x480), 10-column Spider layout renders correctly with face-up and face-down cards. Mouse clicks work for moving cards between columns. Status bar tracks score, moves, rows remaining, and suits removed. All menus and dialogs work.

### Working
- Window creation with menu (resource ID 101)
- SW_MAXIMIZE (ShowWindow cmd=3) — window fills screen, WM_SIZE delivered with correct maximized dimensions
- Card bitmap loading (LoadBitmapA from PE resources)
- Card rendering via BitBlt/SelectObject with SetPixel corner rounding
- Mouse click → card moves between columns (SetCapture/ReleaseCapture)
- Status bar child window with score/moves/rows/suits counters
- New Game (40005) — deals fresh game with new cards, score resets to 500
- Deal Next Row (40007) — deals one row across all 10 columns
- Undo (40010) — reverts last move
- Options dialog (40015): 5 checkboxes (animate, auto-save, auto-open, prompt-save, prompt-open) + OK/Cancel
- Statistics dialog (40014): High Score, Percentage (Wins/Losses/Win Rate), Streaks (Most Wins/Losses/Current) + OK/Reset
- About Spider dialog (40002) — opens with OK button (content area blank)
- Registry settings (RegOpenKeyExA, RegQueryValueExA, RegSetValueExA, RegCreateKeyExA)
- Timer support (SetTimer/KillTimer)
- CoInitialize/CoUninitialize (COM init)
- TranslateAcceleratorA (keyboard accelerators)
- GetClientRect, MoveWindow, InvalidateRect, RedrawWindow

### Known Issues
- About dialog content is blank (custom dialog, text not rendering — may need DrawTextA or static control fix)
- Help (40003) doesn't invoke WinHelpA — may need HtmlHelp support (.CHM file)
- Status bar child window has client height 0 (cosmetic)
- OLEAUT32 ordinal imports unresolved (SysAllocString etc. — needed for COM/sound)

### Not Yet Tested
- Card dragging (mousedown → mousemove → mouseup sequences)
- Save/Open game (40011/40012) — requires file I/O dialogs
- Show An Available Move (40013)
- Restart This Game (40006)

## Menu Structure

| ID | Command | Status |
|----|---------|--------|
| 40005 | New Game (F2) | Working |
| 40006 | Restart This Game | Not tested |
| 40010 | Undo (Ctrl+Z) | Working |
| 40007 | Deal Next Row (D) | Working |
| 40013 | Show An Available Move (M) | Not tested |
| 40014 | Statistics... | Working |
| 40015 | Options... | Working |
| 40011 | Save This Game (Ctrl+S) | Not tested |
| 40012 | Open Last Saved Game (Ctrl+O) | Not tested |
| 40004 | Exit | Working |
| 40003 | Help Contents (F1) | Not working (no WinHelpA call) |
| 40002 | About Spider... | Working (blank content) |

## DLL Imports

| DLL | Key Functions |
|-----|--------------|
| USER32 | CreateWindowExA, GetMessageA, ShowWindow, SetCapture, ReleaseCapture, LoadBitmapA, LoadImageA, LoadAcceleratorsA, TranslateAcceleratorA, DialogBoxParamA, SetTimer, InvertRect, PeekMessageA, WaitMessage, RedrawWindow |
| GDI32 | SelectObject, BitBlt, StretchBlt, SetPixel, GetPixel, LineTo, MoveToEx, TextOutA, GetTextExtentPoint32A, CreatePen, CreateSolidBrush, CreateCompatibleDC/Bitmap |
| KERNEL32 | CreateFileA, ReadFile, WriteFile, GetTickCount, GlobalAlloc/Free, LocalAlloc/Free, FormatMessageA, HeapAlloc/Free/Create |
| ADVAPI32 | RegOpenKeyExA, RegQueryValueExA, RegSetValueExA, RegCreateKeyExA, RegCloseKey |
| ole32 | CoInitialize, CoUninitialize, CoCreateInstance, CLSIDFromString, CLSIDFromProgID, OleRun |
| OLEAUT32 | ordinals 2/6/7/9/150/200 (SysAllocString, SysAllocStringLen, SysReAllocStringLen, SysFreeString, SysStringLen, VariantInit) |

## Key Fixes Applied

1. **SW_MAXIMIZE support** (2026-04-11): ShowWindow with cmd=3 now resizes the window to fill the canvas. The renderer's `showWindow` sets window dimensions to canvas size and recomputes `clientRect`. The WAT handler uses the host-returned client size for the WM_SIZE lParam instead of the stale `pending_wm_size`. Also clears `pending_wm_size` to prevent a second WM_SIZE with old dimensions. Fixed in both `lib/renderer.js`, `lib/host-imports.js`, `test/run.js`, and `src/09a5-handlers-window.wat`.
