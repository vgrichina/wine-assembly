# Pegged (Windows Entertainment Pack)

Peg solitaire game from the Windows Entertainment Pack. 32-bit PE, 44KB, pure Win32 API (no MFC runtime needed despite AfxWinMain reference in IAT — it's the CRT entry).

## Binary Info

- **File:** `test/binaries/entertainment-pack/pegged.exe`
- **Size:** 43,792 bytes
- **Image base:** 0x01000000
- **Entry point:** 0x01007550 (CRT startup)
- **Sections:** .text (0x6FE4), .data (0x608), .rsrc (0xFD0), .reloc (0x167A)

## Key Addresses

| Address | Description |
|---------|-------------|
| 0x01007550 | CRT entry point |
| 0x01001310 | WinMain (approx start of RegisterClass setup) |
| 0x01001510 | WndProc |
| 0x010014B2 | Message loop (GetMessage/TranslateAccelerator/Dispatch) |
| 0x010064C8 | WndProc message switch |
| 0x01001567 | WM_COMMAND handler |
| 0x010056F8 | WM_PAINT handler |
| 0x0100403B | WM_LBUTTONDOWN handler |
| 0x01004B28 | WM_LBUTTONUP handler |
| 0x010015AD | Board init loop (Cross board) |

## Data Layout (.data section, base 0x01008000)

| Address | Type | Description |
|---------|------|-------------|
| 0x01008000 | DWORD | Game state / move counter |
| 0x01008004 | DWORD | Board type (from ini?) |
| 0x01008008 | DWORD | Flag: Cross board selected |
| 0x0100800C | DWORD | Flag: Plus board selected |
| 0x01008010 | DWORD | Flag: Fireplace board selected |
| 0x01008014 | DWORD | Flag: Up Arrow board selected |
| 0x01008018 | DWORD | Flag: Pyramid board selected |
| 0x0100801C | DWORD | Flag: Diamond board selected |
| 0x01008020 | DWORD | Flag: Solitaire board selected |
| 0x01008024 | DWORD | Flag: (8th board or prev-game flag) |
| 0x01008040 | string | "Pegged" (window class name) |
| 0x01008090 | DWORD | Grid drawing offset X |
| 0x01008094 | DWORD | Cell size / spacing |
| 0x0100809C | DWORD | Grid dimension related |
| 0x010080B4 | DWORD | Screen width (SM_CXSCREEN) |
| 0x010080B8 | DWORD | Board dimension (rows/cols visible) |
| 0x010080C0 | DWORD | Window client height |
| 0x010080D8 | DWORD[7][7] | Board state array (7×7 grid, 196 bytes) |
| 0x010081B0 | DWORD | Screen height (SM_CYSCREEN) |
| 0x010081C4 | DWORD | Grid drawing offset Y |
| 0x010081D4 | DWORD | Cell size (alternate axis) |
| 0x010081E8 | HDC | Memory DC for double-buffering |
| 0x01008210 | HICON | Application icon handle |
| 0x01008218 | HBRUSH | Board background brush |
| 0x01008220 | HPEN | Drawing pen |
| 0x01008584 | HACCEL | Accelerator table handle |
| 0x010085B0 | HWND | Main window handle |
| 0x010085CC | WORD | Currently checked menu item ID |
| 0x010085D8 | HPEN/HBRUSH | Current drawing object |

## Board State Array (0x010080D8)

7×7 grid of DWORDs. Index: `board[row][col]` = `[0x10080D8 + (row*7 + col) * 4]`

Cell values:
- **0** = empty hole (valid position, no peg)
- **1** = peg present
- **Not set / outside board** = invalid position (corners for Cross board, etc.)

The general init loop at 0x10015AD handles the Cross board pattern: rows 0-6, cols 0-6. Corners (row<=1 or row>=5) AND (col<=1 or col>=5) are skipped. Center (3,3) starts empty.

For non-Cross boards, init sets cells directly via hardcoded MOV instructions (no loop/table — pure inline constants).

## Board Layouts (7 types)

### Cross (ID 3, flag at 0x1008008)
```
  . . * * * . .
  . . * * * . .
  * * * * * * *
  * * * o * * *
  * * * * * * *
  . . * * * . .
  . . * * * . .
```

### Plus (ID 4, flag at 0x100800C)
```
  . . . * . . .
  . . * * * . .
  . * * * * * .
  * * * * * * *
  . * * * * * .
  . . * * * . .
  . . . * . . .
```
(Center peg at (3,3) present; differs from Cross — init sets specific cells)

### Fireplace (ID 5, flag at 0x1008010)
_Board layout in init code at ~0x1001A6E_

### Up Arrow (ID 6, flag at 0x1008014)
_Board layout in init code at ~0x1001BC4_

### Pyramid (ID 7, flag at 0x1008018)
_Board layout in init code_

### Diamond (ID 8, flag at 0x100801C)
_Board layout in init code_

### Solitaire (ID 9, flag at 0x1008020)
Confirmed: sets cells directly. Init at 0x10017CD.
```
  . * . . . * .
  . * * . * * .
  * * * * * * *
  * * * * * * *
  . * * * * * .
  . . * * * . .
  . . . * . . .
```
(Reconstructed from hardcoded MOVs at 0x10017CD-0x1001917)

## Imports

### KERNEL32.dll (4)
GetStartupInfoA, GetModuleHandleA, GetPrivateProfileIntA, WritePrivateProfileStringA

### GDI32.dll (16)
CreatePen, GetViewportOrgEx, GetDeviceCaps, CreateSolidBrush, CreateCompatibleDC, CreateCompatibleBitmap, Rectangle, MoveToEx, LineTo, Ellipse, Arc, BitBlt, SelectObject, DeleteDC, DeleteObject, GetStockObject

### USER32.dll (35)
BeginPaint, ReleaseDC, ShowCursor, GetDC, ReleaseCapture, SetCapture, GetWindowRect, PostMessageA, MoveWindow, CheckMenuItem, GetMenu, DestroyWindow, EnableMenuItem, EndPaint, DispatchMessageA, TranslateMessage, TranslateAcceleratorA, GetMessageA, LoadAcceleratorsA, UpdateWindow, ShowWindow, CreateWindowExA, GetSystemMetrics, RegisterClassA, LoadCursorA, LoadIconA, BringWindowToTop, GetLastActivePopup, SendMessageA, FindWindowA, DefWindowProcA, PostQuitMessage, WinHelpA, KillTimer, MessageBoxA

### msvcrt.dll (13)
Standard CRT init functions

### ABOUTWEP.dll (1)
AboutWEP — about dialog helper

## Resources

- **1 Menu** — Game (New, Backup, Exit), Options (7 board shapes), Help
- **2 Icons** — 32×32, 4bpp (both identical — app icon)
- **1 Accelerator table** — F1=Help, F2=New, Bksp=Backup, Esc=cancel

## Menu Command IDs

| ID | Command |
|----|---------|
| 1 | New Game |
| 2 | Backup (undo) |
| 3 | Cross board |
| 4 | Plus board |
| 5 | Fireplace board |
| 6 | Up Arrow board |
| 7 | Pyramid board |
| 8 | Diamond board |
| 9 | Solitaire board |
| 11 | About |
| 12 | (Esc handler) |
| 13 | Exit |
| 14 | Help Index |
| 15 | How to Play |
| 16 | Commands |
| 17 | Using Help |

## WndProc Message Dispatch (0x010064C8)

| Message | Handler | Notes |
|---------|---------|-------|
| WM_CREATE (1) | 0x01002F62 | Init brushes, pens, DC, board |
| WM_DESTROY (2) | 0x010061CF | Cleanup, PostQuitMessage |
| WM_MOVE (3) | 0x01003FE8 | |
| WM_SIZE (5) | 0x0100320F | Resize board grid |
| WM_PAINT (0xF) | 0x010056F8 | Draw board, pegs, grid lines |
| WM_ERASEBKGND (0x14) | 0x0100401F | |
| WM_MOUSEACTIVATE (0x21) | 0x01004010 | |
| WM_COMMAND (0x111) | 0x01001567 | Menu/accel dispatch |
| WM_INITMENUPOPUP (0x117) | 0x01001534 | Enable/disable Backup |
| WM_LBUTTONDOWN (0x201) | 0x0100403B | Select peg |
| WM_LBUTTONUP (0x202) | 0x01004B28 | Complete move |

## Game Logic

The game is classic peg solitaire:
1. Click a peg to select it
2. Jump it over an adjacent peg into an empty hole
3. The jumped peg is removed
4. Goal: minimize remaining pegs (ideal: 1 left)

**Backup** (Undo) is supported via stored previous state.

**Settings persistence:** Uses `GetPrivateProfileIntA` / `WritePrivateProfileStringA` — saves to an INI file (likely `pegged.ini` in Windows directory).

## Drawing Architecture

Uses **three DCs** and a multi-pass rendering pipeline:

| DC | Storage | Purpose |
|----|---------|---------|
| paintDC (`[ebp-0x5c]`, handle 0x50001) | Canvas | Screen output from BeginPaint/GetDC |
| memDC (`[0x10081e8]`) | Bitmap at `[0x10081ec]` | Board background cache (grid + arcs) |
| secondDC (`[0x100859c]`) | Bitmap at `[0x10085dc]` | Cell-level save/restore buffer |
| spriteDC (`[0x10081d8]`) | Bitmap at `[0x1008590]` | Floating peg sprite during drag |

### WM_PAINT Flow (0x10056F8)

1. **SelectObject** pen+brush into paintDC
2. **Rectangle** on paintDC → clears screen background
3. **SelectObject** pen+brush into memDC
4. **Rectangle** on memDC → clears bitmap background
5. **SelectObject** pen into memDC, then **MoveToEx/LineTo** → draw grid lines on memDC
6. **Two Arc loops** (rows 0-6, cols 0-6) on memDC → draw hole outlines (3D effect)
7. **BitBlt** memDC → paintDC (SRCCOPY) → copy board background to screen
8. **BitBlt** memDC → secondDC (via SelectObject swap) → save board state
9. **Peg loop** (rows 0-6, cols 0-6): check `board[row*7+col]` at 0x10080D8
   - If peg present: **Ellipse** on paintDC (peg body), second **Ellipse** (outline), **Arc** (3D highlight)
   - All peg drawing targets paintDC (the screen), not memDC
10. **BitBlt** paintDC → memDC → save complete rendered frame back to bitmap cache
11. **EndPaint**
12. If `[0x100803c]` set → show MessageBox (game won/over)

### Mouse Click / Drag Flow (0x100403B)

**WM_LBUTTONDOWN:**
1. GetDC to get paintDC
2. Extract mouse X (lParam low word), Y (lParam high word)
3. Hit-test: `col = X / cellWidth - 1`, `row = Y / cellHeight - 1`
4. Check `board[row*7+col]` — if empty, release DC and return
5. Check cross-board corner exclusion
6. **BitBlt** secondDC → paintDC (restore cell from saved background)
7. **BitBlt** secondDC → memDC (update memDC too)
8. Capture area around mouse from memDC → **spriteDC** (0x10081d8)
9. Draw peg on **spriteDC** with Ellipse + Arc
10. BitBlt spriteDC → paintDC (show floating peg at cursor)
11. SetCapture, ShowCursor(FALSE)

**WM_LBUTTONUP (0x1004B28):**
- Validates drop target, executes jump logic, updates board array
- Redraws affected cells

### Key Data Addresses for Drawing

| Address | Description |
|---------|-------------|
| 0x01008090 | Grid origin X (pixel offset) |
| 0x0100809C | Cell width (pixels) |
| 0x010080A4 | Peg inset (for Ellipse positioning) |
| 0x010080A8 | Peg half-size |
| 0x010080B8 | Cell height (pixels) |
| 0x010080BC | Peg highlight offset |
| 0x010080C0 | Client area width |
| 0x010080C8 | Peg drawing offset |
| 0x010081C0 | Peg vertical half-size |
| 0x010081C4 | Grid origin Y (pixel offset) |
| 0x010081AC | Arc end offset |

## Emulator Bugs (FIXED)

### Bug 1+2: GDI drawing to memory DCs — FIXED

**Problem:** All GDI drawing functions (Ellipse, Arc, LineTo, Rectangle) always drew to the HTML canvas regardless of which DC was targeted. Memory DCs got no drawing, and window offsets were incorrectly applied to bitmap-local coordinates.

**Fix (in `lib/host-imports.js`):** Canvas-backed bitmaps. Each bitmap created via `CreateCompatibleBitmap`, `CreateBitmap`, or `LoadBitmap` now gets an associated OffscreenCanvas. A `_getDrawTarget(hdc, hwnd)` helper returns the correct canvas context and origin offset (0,0 for memory DCs, client origin for window DC). All drawing functions and BitBlt now use this unified approach:
- `gdi_rectangle`, `gdi_ellipse`, `gdi_arc`, `gdi_line_to` → use `_getDrawTarget`
- `gdi_bitblt` → uses `drawImage` for SRCCOPY, `getImageData`/`putImageData` for complex ROPs
- Text rendering for memory DCs draws directly into bitmap canvas

## Emulator Status

Runs in wine-assembly:
- Window creates successfully: "Pegged" 240×240
- Board fully renders: grid lines, 3D hole outlines (Arc), blue pegs (Ellipse), background (Rectangle)
- Double-buffering works correctly (memDC ↔ paintDC via BitBlt)
- Gets stuck in infinite `[Exit] code=0` loop after WM_CLOSE injection (pre-existing message loop issue)
- Peg dragging needs live browser testing (requires mouse interaction)
