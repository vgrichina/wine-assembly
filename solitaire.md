# Solitaire (sol.exe) — Entertainment Pack Debug Build

Binary: `test/binaries/entertainment-pack/sol.exe`
Test: `test/test-solitaire-deal.js`

## Status (2026-04-11)

Game is fully playable in the browser. Cards deal, render, and respond to all mouse interactions: click to select, double-click to auto-move to foundation, drag cards between piles, click deck to flip. Score and game number update correctly. Re-deal produces unique game numbers. All 6 test checks pass.

Victory animation (Force Win menu command 1010) works — cascading cards via cdtDrawExt + PeekMessageA loop.

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
- Double-click → auto-move card to foundation (via WM_LBUTTONDBLCLK)
- Card drag between piles (SetCapture → WM_MOUSEMOVE → ReleaseCapture)
- Mouse capture routing: handleMouseMove/handleMouseUp respect capture_hwnd
- Game > Deal re-deal with different game number (time-based srand seed)
- GetKeyState, CopyRect, InflateRect, SetCursorPos, InvertRect, PtInRect
- Victory animation (Force Win): cdtDrawExt cascading cards
- Options dialog (103): Draw One/Three, scoring mode, checkboxes — fully rendered
- Set Game Number dialog (102): static labels, edit control, Deal/Cancel
- Select Card Back dialog (101): OK/Cancel buttons work (card back previews need owner-draw)
- Browser-side double-click detection for WM_LBUTTONDBLCLK

### Known Issues
- **Select Card Back dialog**: 12 card back buttons are BS_OWNERDRAW — need WM_DRAWITEM support
- Status bar child window has negative client height (`"h":-12`) — cosmetic

### Not Yet Tested
- Card movement animation (cdtAnimate — called during auto-move)
- Help (WinHelpA)
- About (ShellAboutA — routed through menu command 2000)
- Scoring modes (standard, vegas, none, timed) — dialog controls work, runtime behavior untested

## Drag Trail Bug (FIXED)

The solitaire uses a triple-buffered BitBlt compositing scheme during card drag:
- DC 0x200009: composite buffer (initially saved from screen at card pickup position)
- DC 0x200005 / DC 0x200007: alternating background save buffers
- Green brush 0x200004: CreateSolidBrush(0x008000), used to clear buffers before drag

Each WM_MOUSEMOVE triggers a 5-step compositing sequence (dx=30 for the test case):
1. `BitBlt(newBgnd, 0,0, w,h, screen, newX,newY)` — save new background
2. `BitBlt(newBgnd, -dx,0, w,h, oldBgnd, 0,0)` — merge old background into new
3. `BitBlt(oldBgnd, dx,0, w,h, composite, 0,0)` — position composite overlay
4. `BitBlt(screen, newX,newY, w,h, composite, 0,0)` — draw composite at new pos
5. `BitBlt(screen, oldX,oldY, w,h, oldBgnd, 0,0)` — erase old position

### Root causes found and fixed

**1. Node-mode premature repaint (FIXED)**
`_getDrawTarget()` called `scheduleRepaint()` which in Node mode triggered a synchronous repaint BEFORE the BitBlt write completed. Each BitBlt composited the back canvas in a stale state, causing a one-frame lag where the erase step wasn't visible.

Fix: `scheduleRepaint()` in Node mode now defers to `flushRepaint()` called after each WASM batch (`lib/renderer.js`, `test/run.js`).

**2. PATCOPY writes to null canvas — stock bitmap has no canvas (FIXED)**
Before dragging, the solitaire clears the background buffers by:
1. `SelectObject(DC5, stockBitmap 0x30001)` — deselects the 71×276 bitmap
2. `SelectObject(DC5, greenBrush 0x200004)` — sets brushColor=0x008000
3. `BitBlt(DC5, 0,0, 71,294, PATCOPY)` — should fill with green
4. `SelectObject(DC5, bitmap 0x200006)` — re-selects the real bitmap

Step 3 failed silently because the stock bitmap (0x30001, 1×1 pixel) had no `.canvas` property. `_getDrawTarget()` returned null, and PATCOPY bailed.

Fix: `_getDrawTarget()` now lazily creates a canvas for any bitmap that lacks one (`lib/host-imports.js`).

**3. Mouse capture not respected in renderer input (FIXED)**
handleMouseMove/handleMouseUp only delivered messages when the cursor was within a window's bounds. During a drag outside the window, mouse messages stopped.

Fix: Both handlers now check `get_capture_hwnd` export and route all mouse messages to the capturing window regardless of cursor position (`lib/renderer-input.js`).

**4. ReleaseCapture workaround removed**
The previous workaround forced a full WM_PAINT via InvalidateRect on ReleaseCapture. Removed (`src/09a4-handlers-gdi.wat`) since it masked the real bug.

### Debugging the drag trail

Use these flags to trace the compositing:
```bash
node test/run.js --exe=test/binaries/entertainment-pack/sol.exe --trace-gdi --dump-backcanvas \
  --input="...,920:mousedown:50:190,960:mousemove:80:190,1060:png:scratch/drag.png" --max-batches=1100
```
- `--trace-gdi` logs every BitBlt/SelectObject/CreateSolidBrush with full parameters
- `--dump-backcanvas` saves each window's back canvas alongside PNG snapshots
- `mousedown:X:Y` / `mousemove:X:Y` / `mouseup:X:Y` input actions simulate drag

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

| ID | Purpose | Controls | Status |
|----|---------|----------|--------|
| 101 | Card back selection | 12 owner-draw buttons (ids 54-65) + OK/Cancel | Opens, buttons empty (needs WM_DRAWITEM) |
| 102 | Select game number | Static labels, Edit control (id 200), Deal/Cancel | Fully working |
| 103 | Options | Draw One/Three radios (300-301), Scoring radios (302-304), checkboxes (305-308), OK/Cancel | Fully working |
| 999 | Debug assertion | File/line/game# statics, Continue/Exit buttons | Working |

## Menu Structure

| ID | Command | Notes |
|----|---------|-------|
| 1000 | Deal | Re-deals cards, new game number |
| 1001 | Undo | |
| 1002 | Deck... | Card back selection dialog (101) |
| 1003 | Options... | Options dialog (103) |
| 1004 | Exit | |
| 1005 | Set Game Number | Game number dialog (102) — debug menu |
| 1010 | Force Win | Triggers victory animation — debug menu |
| 2000 | About Solitaire | ShellAboutA |
| 65535 | Help Contents | WinHelpA |

## Key Fixes Applied

1. **ShowWindow WM_SIZE delivery** (2026-04-10): Two bugs prevented WM_SIZE from reaching the wndproc:
   - Bitwise AND coercion: `i32.and nCmdShow=10 boolean=1` → 0 (bit 0 of 10 is 0). Fixed with `i32.ne` coercion.
   - Return address offset: read from `[esp+20]` instead of `[esp+8]` after stack adjustment. Fixed offset.
2. **Mouse interaction APIs** (2026-04-10): Implemented GetKeyState, CopyRect, InflateRect, SetCursorPos to unblock mouse click handling.
3. **Time progression** (2026-04-10): GetLocalTime/GetSystemTime/GetSystemTimeAsFileTime now vary with simulated ticks instead of returning constants.
4. **Deferred Node-mode repaint** (2026-04-10): `scheduleRepaint()` no longer triggers synchronous repaint in Node mode.
5. **Lazy bitmap canvas** (2026-04-10): `_getDrawTarget()` creates a canvas for bitmaps that lack one, fixing PATCOPY on the stock bitmap.
6. **Mouse capture routing** (2026-04-10): handleMouseMove/handleMouseUp respect `$capture_hwnd` for drag outside window bounds.
7. **Dialog control style** (2026-04-11): Dialog creation now stores the control's style from the dialog template into the WND_RECORD. Fixes groupbox labels and any style-dependent button rendering.
8. **Browser double-click** (2026-04-11): handleMouseDown detects double-clicks and sends WM_LBUTTONDBLCLK for auto-move to foundation.

## Architecture Notes

- **Card rendering**: cards.dll provides cdtDraw(hdc, x, y, card, mode, bgColor). Card IDs encode suit×13+rank. The DLL has 74 bitmaps (52 face cards + card backs + empty slots).
- **Pile positions**: Computed in WM_SIZE handler at 0x01001e7e. Uses client width to calculate horizontal spacing: `cols = (cx - 7*cardWidth) / 8 + 3`. Positions stored in game state structures allocated via LocalAlloc.
- **Game number**: Seeded from `time()` via `srand()`. Displayed in status bar as "Game # NNNNN".
- **Assertion mechanism**: Debug build has Assert() at util.c:125 that fires DialogBoxParamA with dialog 999. Checks pile rect validity (`left <= right`, `top <= bottom`).
- **Wndproc**: At 0x01001cd0. Message dispatch via jump table at 0x01002442 for msgs 2-8 (WM_DESTROY, WM_MOVE, WM_SIZE, WM_SETFOCUS, WM_KILLFOCUS). Higher messages dispatched via cmp chains.
- **Drag DCs**: Three 71×276 compatible DCs (0x200005, 0x200007, 0x200009) created at startup. Green brush 0x200004 = CreateSolidBrush(0x008000).
