# Solitaire (sol.exe) — Entertainment Pack Debug Build

Binary: `test/binaries/entertainment-pack/sol.exe`
Test: `test/test-solitaire-deal.js`

## Status (2026-04-10)

Game is fully interactive. Cards deal, render correctly, and respond to mouse clicks. Deck clicks flip cards to waste pile, double-click auto-moves cards to foundation (score updates). Re-deal produces different game numbers. All 6 test checks pass.

### Working
- Window creation with menu (resource ID 1)
- WM_SIZE delivery via ShowWindow → wndproc redirect
- Card pile layout computation (computed during WM_SIZE handler)
- Initial deal (WM_COMMAND 1000 posted during WinMain)
- Card rendering: BitBlt with SetPixel corner rounding, GetPixel readback
- Status bar (child window hwnd=0x10002, custom class) with score/time/game#
- Timer (SetTimer id=0x29a, 250ms)
- Profile settings (GetProfileIntA/GetProfileStringA for card back, draw mode)
- DLL loading: cards.dll (74 bitmaps), msvcrt.dll
- Mouse click → card selection (SetCapture/PtInRect/ReleaseCapture)
- Deck click → flip cards to waste pile (draw-3 mode)
- Double-click → auto-move card to foundation (score updates)
- Game > Deal re-deal with different game number (time-based srand seed)
- GetKeyState, CopyRect, InflateRect, SetCursorPos, InvertRect all implemented

### Open Issues
- EndDialog flow not verified end-to-end (browser click → Continue → EndDialog)
- Options dialog (103) radio buttons need checked state sync (draw-1/draw-3, scoring)
- Status bar child window has negative client height (`"h":-12`) — cosmetic

### Not Yet Tested
- Card dragging between tableau columns (click-select then click-destination)
- Card movement animation (cdtAnimate)
- Game > Options dialog (dialog 103: draw-1/draw-3, scoring mode)
- Deck back selection dialog (dialog 101: 12 card back bitmaps)
- Select Game # dialog (dialog 102: edit control + number input)
- Help (WinHelpA)
- About (ShellAboutA)
- Scoring modes (standard, vegas, none, timed)
- Win detection and congratulations

## DLL Imports

| DLL | Key Functions |
|-----|--------------|
| USER32 | CreateWindowExA, GetMessageA, DispatchMessageA, ShowWindow, SetTimer, SetCapture, CheckMenuItem, InvertRect |
| GDI32 | SelectObject, BitBlt, SetPixel, GetPixel, PatBlt, SetBkColor, CreateCompatibleDC/Bitmap |
| KERNEL32 | GetProfileIntA, GetProfileStringA, WriteProfileStringA, LocalAlloc, MulDiv, OpenFile |
| CARDS.dll | cdtInit, cdtDraw, cdtDrawExt, cdtAnimate, cdtTerm |
| SHELL32 | ShellAboutA |
| msvcrt | rand, srand, time (game number seed) |

## Dialogs

| ID | Purpose | Controls |
|----|---------|----------|
| 101 | Card back selection | 12 radio buttons (ids 54-65) + OK/Cancel |
| 102 | Select game number | Static labels, Edit control (id 200), Deal/Cancel |
| 103 | Options | Draw One/Three radios (300-301), Scoring radios (302-304), checkboxes (305-308), OK/Cancel |
| 999 | Debug assertion | File/line/game# statics, Continue/Exit buttons |

## Key Fixes Applied

1. **ShowWindow WM_SIZE delivery** (2026-04-10): Two bugs prevented WM_SIZE from reaching the wndproc:
   - Bitwise AND coercion: `i32.and nCmdShow=10 boolean=1` → 0 (bit 0 of 10 is 0). Fixed with `i32.ne` coercion.
   - Return address offset: read from `[esp+20]` instead of `[esp+8]` after stack adjustment. Fixed offset.
2. **Mouse interaction APIs** (2026-04-10): Implemented GetKeyState, CopyRect, InflateRect, SetCursorPos to unblock mouse click handling.
3. **Time progression** (2026-04-10): GetLocalTime/GetSystemTime/GetSystemTimeAsFileTime now vary with simulated ticks instead of returning constants. Fixes srand seeding so re-deal produces different game numbers.

## Architecture Notes

- **Card rendering**: cards.dll provides cdtDraw(hdc, x, y, card, mode, bgColor). Card IDs encode suit×13+rank. The DLL has 74 bitmaps (52 face cards + card backs + empty slots).
- **Pile positions**: Computed in WM_SIZE handler at 0x01001e7e. Uses client width to calculate horizontal spacing: `cols = (cx - 7*cardWidth) / 8 + 3`. Positions stored in game state structures allocated via LocalAlloc.
- **Game number**: Seeded from `time()` via `srand()`. Displayed in status bar as "Game # NNNNN".
- **Assertion mechanism**: Debug build has Assert() at util.c:125 that fires DialogBoxParamA with dialog 999. Checks pile rect validity (`left <= right`, `top <= bottom`).
- **Wndproc**: At 0x01001cd0. Message dispatch via jump table at 0x01002442 for msgs 2-8 (WM_DESTROY, WM_MOVE, WM_SIZE, WM_SETFOCUS, WM_KILLFOCUS). Higher messages dispatched via cmp chains.
