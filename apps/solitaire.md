# Solitaire (sol.exe) — Entertainment Pack Debug Build

Binary: `test/binaries/entertainment-pack/sol.exe`
Test: `test/test-solitaire-deal.js`

## Status (2026-04-17)

**Fixed.** Restored synchronous main-window `WM_SIZE` delivery by extending the activation chain with a new `CACA0024` step between `CACA0023` (WM_SETFOCUS) and `CACA0001` (done). `WM_SIZE` is now sent synchronously to the main wndproc before the message loop runs, matching real Win32 semantics and ensuring pile rects are populated before the posted Deal fires. `test/test-solitaire-deal.js` passes 6/6; no assertion dialog.

### Historical root cause — WM_SIZE / Deal ordering regression from 869248d (pre-2026-04-17)

Wndproc address confirmed as **`0x01001cd0`** (from `RegisterClassExA` at `0x01001a77`; `WNDCLASSEX.lpfnWndProc` set by `mov dword [ebp-0x74], 0x1001cd0` at `0x01001a18`). The earlier "951 hits all msg=1" observation was `--trace-at` misfiring; probing `$handle_DispatchMessageA` directly with `$host_log_i32` confirms that path resolves to `0x01001cd0` and successfully sets `$eip` on the WM_COMMAND Deal dispatch. `--break=0x01002790` also confirms the Deal function itself (`0x01002790`) runs, reaches `msvcrt!time` / `srand` / `rand`, and writes the new game# to `[0x0100d060]`.

What actually breaks is message ordering:

1. `sol` posts `WM_COMMAND wParam=0x3e8 (Deal)` during `WinMain` via `PostMessageA` (before the message loop starts).
2. Main-window `WM_SIZE` is deferred onto `$pending_wm_size`, delivered later by `$handle_GetMessageA`.
3. `$handle_GetMessageA` (`src/09a5-handlers-window.wat:601-630`) drains the post queue **before** `pending_wm_size`, by design — the in-source comment states this order is intentional so that apps that create game objects in response to posted WM_COMMANDs have them ready when WM_SIZE lays things out.
4. Pre-regression (before `869248d`), `ShowWindow` delivered `WM_SIZE` synchronously via EIP redirect, so pile rects were populated before the message loop ran. `869248d` moved main-window activation to the CACA0020-0023 chain, which only covers `WM_ACTIVATEAPP → WM_ACTIVATE → WM_SETFOCUS` — it dropped the synchronous `WM_SIZE`.
5. Net effect: Deal now runs against an un-sized wndproc state. The pile rects are still zero-init, `left > right` fails the `Assert` at `util.c:125`, and `DialogBoxParamA(0x01000000, 0x3e7, …)` fires at API #1235 — the debug-build assertion dialog with the file path, `"125"`, `"17280"` (game#) strings. The emulator gets stuck waiting in that modal dialog; on the web the deck back and status bar are drawn but the tableau never appears.

Message-trace probe output showing the miss (no `msg=0x0005` ever dispatched to `0x10001`):

```
hwnd=0x10002 msg=0x001 wndproc=0x01009fa0   # child WM_CREATE
hwnd=0x10002 msg=0x005 wndproc=0x01009fa0   # child WM_SIZE
hwnd=0x10001 msg=0x018 wndproc=0x01001cd0   # main WM_SHOWWINDOW
hwnd=0x10002 msg=0x018 wndproc=0x01009fa0   # child WM_SHOWWINDOW
hwnd=0x10001 msg=0x111 wndproc=0x01001cd0   # main WM_COMMAND 0x3e8 (Deal)  ← fires with no prior WM_SIZE
```

### Comparison with real Win32

In a standard `WinMain` → `CreateWindowEx` → `ShowWindow` → message loop flow, real USER32 delivers messages in this order (all messages before step 7 are **SendMessage-style**, i.e. synchronous calls into the wndproc on the creating thread's stack):

1. `CreateWindowEx` internally sends:
   - `WM_GETMINMAXINFO` → `WM_NCCREATE` → `WM_NCCALCSIZE` → `WM_CREATE`
   - (sol's `WM_CREATE` handler calls `PostMessageA(hwnd, WM_COMMAND, Deal, 0)` — this only *queues* the message; it does not run now.)
2. `CreateWindowEx` returns.
3. `ShowWindow` internally sends:
   - `WM_SHOWWINDOW` → `WM_WINDOWPOSCHANGING` → `WM_ACTIVATEAPP` → `WM_NCACTIVATE` → `WM_ACTIVATE` → `WM_SETFOCUS` → `WM_NCPAINT` → `WM_ERASEBKGND` → `WM_WINDOWPOSCHANGED` → **`WM_SIZE`** → `WM_MOVE`.
4. `ShowWindow` returns.
5. `UpdateWindow` → synchronous `WM_PAINT`.
6. App enters `GetMessage` / `DispatchMessage` loop.
7. First dequeued message is the posted `WM_COMMAND Deal`.

Critical property: `WM_SIZE` is **always** dispatched before any `PostMessage`d message, because it rides the synchronous ShowWindow call chain while `PostMessage` only touches the queue. Sol relies on this — Deal reads pile rects that the `WM_SIZE` handler populates.

Wine-Assembly before `869248d` matched this: `ShowWindow` redirected EIP to the wndproc with `WM_SIZE` before returning, so by the time the message loop dequeued the posted Deal, the wndproc had already run `WM_SIZE`.

`869248d` moved the synchronous chain to `CreateWindowExA` (CACA0020-0023) but dropped `WM_SIZE` from it; the current chain only covers `WM_ACTIVATEAPP → WM_ACTIVATE → WM_SETFOCUS`. `WM_SIZE` got demoted to async delivery via `$pending_wm_size` in `GetMessageA`, **after** the post-queue drain — which inverts the real-Win32 ordering and is why Deal now runs before sol has sized state.

The in-source comment on `$handle_GetMessageA:601-603` ("drain posted message queue BEFORE pending WM_SIZE — apps like Solitaire PostMessage Deal during WM_CREATE, and the subsequent WM_SIZE needs those objects to exist for layout") is backwards relative to Win32. In real Win32, `WM_SIZE` wins against any `PostMessage`d command by construction; the rationale as written only makes sense if WM_SIZE is already async, which is itself the regression.

### Fix applied (2026-04-17)

Chose Option B: extended the synchronous activation chain with a new `CACA0024` step. Chain is now `ShowWindow → CACA0022 (WM_ACTIVATE) → CACA0023 (WM_SETFOCUS) → CACA0024 (WM_SIZE) → CACA0001 (done)`. `CACA0024` consumes `$pending_wm_size` as lParam, sets `NC_FLAGS` bit 2 (WM_NCCALCSIZE pending), then zeroes `$pending_wm_size` so `$handle_GetMessageA`'s drain path doesn't replay it.

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
9. **Synchronous main-window WM_SIZE** (2026-04-17): Added `CACA0024` step to the first-ShowWindow activation chain so `WM_SIZE` is delivered to the main wndproc synchronously (before the message loop), matching Win32 `SetWindowPos → WM_WINDOWPOSCHANGED → WM_SIZE` ordering. Restores the pre-`869248d` invariant: pile rects populated before the posted `WM_COMMAND Deal` fires, so the debug-build `Assert(left <= right && top <= bottom)` at `util.c:125` no longer trips.
10. **WM_DRAWITEM for owner-draw buttons** (2026-04-11): BS_OWNERDRAW buttons now post WM_DRAWITEM to parent dialog proc. ButtonState extended to 64 bytes with embedded DRAWITEMSTRUCT. Owner-draw buttons registered as child windows in renderer for GDI routing. Fixes card back preview in Select Card Back dialog (101).

## Architecture Notes

- **Card rendering**: cards.dll provides cdtDraw(hdc, x, y, card, mode, bgColor). Card IDs encode suit×13+rank. The DLL has 74 bitmaps (52 face cards + card backs + empty slots).
- **Pile positions**: Computed in WM_SIZE handler at 0x01001e7e. Uses client width to calculate horizontal spacing: `cols = (cx - 7*cardWidth) / 8 + 3`. Positions stored in game state structures allocated via LocalAlloc.
- **Game number**: Seeded from `time()` via `srand()`. Displayed in status bar as "Game # NNNNN".
- **Assertion mechanism**: Debug build has Assert() at util.c:125 that fires DialogBoxParamA with dialog 999. Checks pile rect validity (`left <= right`, `top <= bottom`).
- **Wndproc**: At 0x01001cd0. Message dispatch via jump table at 0x01002442 for msgs 2-8 (WM_DESTROY, WM_MOVE, WM_SIZE, WM_SETFOCUS, WM_KILLFOCUS). Higher messages dispatched via cmp chains.
- **Drag DCs**: Three 71×276 compatible DCs (0x200005, 0x200007, 0x200009) created at startup. Green brush 0x200004 = CreateSolidBrush(0x008000).
