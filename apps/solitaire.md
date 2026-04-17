# Solitaire (sol.exe) — Entertainment Pack Debug Build

Binary: `test/binaries/entertainment-pack/sol.exe`
Test: `test/test-solitaire-deal.js`

## Status (2026-04-16) — REGRESSION: Assertion on startup

Sol hits the `Assert(left <= right)` dialog (util.c:125, dialog 999) before the game becomes playable. Args at the failing `push 0x7d` are `(left=81, top=0, right=0, bottom=0)` — the column descriptor's enclosing rect (struct[+0x10], [+0x14]) is uninitialized.

**Bisect:** introduced by `869248d` ("Relocate memory layout +32MB, sync CreateWindowExA activation, RCT progress"). Pre-869 sol runs clean (4662 API calls, no DialogBoxParamA). 869 through HEAD: DialogBoxParamA(0x01000000, 0x3e7, …) fires → "Assertion Failure" dialog at hwnd=65539. Persists at current HEAD and is unaffected by `--screen=800x600` / `1024x768` (CreateWindow still picks 593×431, so the window size is not the variable).

**Working hypothesis:** GetClientRect now returns the real post-NCCALCSIZE client (587×386) earlier than before. Pre-869 the first GetClientRect ran before NCCALCSIZE and the JS fell back to the 640×480 renderer default; sol's column-layout code degenerates when width drops below some threshold and leaves column rects with `right=0`. Needs confirmation — trace sol's column-layout (callers of 0x01004f50) and see what input path leaves the rect zeroed.

**Red herrings ruled out:**
- GetDeviceCaps(HORZRES) scaling: sol calls GetDeviceCaps but CreateWindow size is fixed at 593×431 regardless of reported HORZRES. Not the cause.

## Status (2026-04-11) — (pre-regression snapshot)

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
- Select Card Back dialog (101): OK/Cancel buttons work, 12 card back previews render via WM_DRAWITEM
- Browser-side double-click detection for WM_LBUTTONDBLCLK

### Known Issues
- Status bar child window has negative client height (`"h":-12`) — cosmetic

### Tested — Working
- Scoring modes: Standard ("Score: 0"), Vegas ("Score: -$52"), None (no score shown), Timed game checkbox — all change status bar display correctly
- Help (WinHelpA): help window opens with topic list, navigation works. Text has formatting artifacts from unhandled paragraph codes in HLP parser
- About (ShellAboutA — menu command 2000): dialog renders with app name, version string, and OK button

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
| CARDS.dll | cdtInit, cdtDraw, cdtDrawExt, cdtAnimate, cdtTerm (real PE DLL, no WAT stubs) |
| SHELL32 | ShellAboutA |
| msvcrt | rand, srand, time (game number seed) |

## Dialogs

| ID | Purpose | Controls | Status |
|----|---------|----------|--------|
| 101 | Card back selection | 12 owner-draw buttons (ids 54-65) + OK/Cancel | Fully working — card backs render via WM_DRAWITEM |
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
9. **WM_DRAWITEM for owner-draw buttons** (2026-04-11): BS_OWNERDRAW buttons now post WM_DRAWITEM to parent dialog proc. ButtonState extended to 64 bytes with embedded DRAWITEMSTRUCT. Owner-draw buttons registered as child windows in renderer for GDI routing. Fixes card back preview in Select Card Back dialog (101).

## Architecture Notes

- **Card rendering**: cards.dll provides cdtDraw(hdc, x, y, card, mode, bgColor). Card IDs encode suit×13+rank. The DLL has 74 bitmaps (52 face cards + card backs + empty slots).
- **Pile positions**: Computed in WM_SIZE handler at 0x01001e7e. Uses client width to calculate horizontal spacing: `cols = (cx - 7*cardWidth) / 8 + 3`. Positions stored in game state structures allocated via LocalAlloc.
- **Game number**: Seeded from `time()` via `srand()`. Displayed in status bar as "Game # NNNNN".
- **Assertion mechanism**: Debug build has Assert() at util.c:125 that fires DialogBoxParamA with dialog 999. Checks pile rect validity (`left <= right`, `top <= bottom`).
- **Wndproc**: At 0x01001cd0. Message dispatch via jump table at 0x01002442 for msgs 2-8 (WM_DESTROY, WM_MOVE, WM_SIZE, WM_SETFOCUS, WM_KILLFOCUS). Higher messages dispatched via cmp chains.
- **Drag DCs**: Three 71×276 compatible DCs (0x200005, 0x200007, 0x200009) created at startup. Green brush 0x200004 = CreateSolidBrush(0x008000).
