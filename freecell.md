# FreeCell (Windows Entertainment Pack)

Classic FreeCell from the Windows Entertainment Pack. 32-bit PE, pure Win32 API.

## Binary Info

- **File:** `test/binaries/entertainment-pack/freecell.exe`
- **Image base:** 0x01000000
- **Title format:** "FreeCell Game #N" where N is the seed

## Menu IDs

| ID | Menu > Item |
|----|-------------|
| 101 | Help > About FreeCell... |
| 102 | Game > New Game (F2) |
| 103 | Game > Select Game... (F3) — prompts for game number 1..32000 |
| 105 | Options > Statistics (F4) |
| 106 | Help > Contents |
| 107 | Game > Restart Game |
| 108 | Game > Exit |
| 109 | Options > Messages (toggle checkmark) |
| 110 | Help > Search for Help on... |
| 112 | Help > How to Use Help |

## Dialogs

| RT_DIALOG name | Purpose |
|----------------|---------|
| 2147484970 | Menu resource (actually a menu, not a dialog) |
| 2147484988 | "Move to Empty Column..." (Move column / Move single card / Cancel) |
| 2147485004 | "Game Number" — Select Game prompt (edit id=203, OK id=1) |
| 2147485020 | "Game Over" — lose/play-again (Yes/No + "Same game" checkbox) |
| 2147485036 | (statistics or similar) |

## Status

- **Launches:** yes (`node test/run.js --exe=test/binaries/entertainment-pack/freecell.exe`)
- **New Game (F2):** works — deterministic seed from `tick_count`
- **Select Game (F3):** works — dialog closes on OK, title updates to "Game #N"
- **Card move:** works — click-to-pick, click-to-drop on columns and free cells
- **Options > Messages toggle:** checkmark now renders in dropdown
- **Initial state:** empty table on startup (intended — user starts a game with F2 / Game > New Game)
- **New deal after F2:** cards render correctly

## Tests

- `test/test-freecell-move.js` — pins game #1 via Select Game, clicks col1 bottom (6♠) then free cell 1, verifies canvas diff > 500 px.
- `test/test-freecell-stats.js` — sends WM_COMMAND(105) (Options > Statistics / F4), verifies the "FreeCell Statistics" dialog renders (canvas diff + dialog-face gray pixel count).
- `test/test-freecell-dblclick.js` — pins game #1, double-clicks col1 bottom (6♠). Auto-move routes the card to free cell #1 (home isn't legal without the ace of spades); test verifies the card pixels now occupy that cell.

## Emulator Fixes That Unblocked FreeCell

| Commit | Fix |
|--------|-----|
| `7fc3947` | `SetRectRgn` was `crash_unimplemented`; turned into a noop (regions here are already fake counter handles used only for drag-rect clipping) |
| `bdca458` | `GetDlgItemInt` was a return-0 stub; now reads the child Edit's WAT state_ptr buffer directly and parses decimal, so Select Game can validate its input |
| (this) | `CheckMenuItem` was a pure noop; now walks every window's menu blob and toggles bit2 of matching items, and `menu_paint_dropdown` draws a small filled square in the left margin for checked items. Also made `$menu_load` idempotent (first load wins) and eager-loaded the menu blob in `$handle_CreateWindowExA` so CheckMenuItem fired from WM_CREATE sees a valid blob. |
| (this) | `shell_about` in browser `host.js` was calling a non-existent `renderer.showAboutDialog`; now just logs (the About dialog is built natively by WAT's `$create_about_dialog`) |

## Initial Deal Bug — Root Cause Analysis

**Symptom:** On startup, the table shows 8 empty green columns with no cards. F2 (New Game) deals correctly.

**Flow traced via disassembly:**

1. **WinMain** (0x01001370): calls `InitApplication` (0x1001430) → `InitInstance` (0x1001540) → message loop. There is NO `SendMessage(WM_COMMAND, IDM_DEAL)` anywhere in WinMain or InitInstance.

2. **InitInstance** (0x1001540): Creates window, calls ShowWindow → UpdateWindow → returns. ShowWindow correctly delivers WM_SIZE synchronously (confirmed: DrawMenuBar fires at API #122).

3. **WM_PAINT handler** (0x1001dcc → 0x1003a30): Draws table lines, then calls the deal/draw function at **0x1004520(hdc, 1, 1)**. After that, enters a loop over 8 columns reading the card array at **0x1008ab0**.

4. **Deal function** (0x1004520):
   - Entry guard: `if ([0x1008010] == arg2) return` — gameState=2 (from PE .data), arg2=1, so 2≠1 → proceeds.
   - `arg2` is overwritten with gameState (2) since original arg2==1.
   - `arg3` (1) ≠ 0 → enters deal body at 0x1004565.
   - Creates a compatible DC (succeeds), then at **0x1004581**: `cmp [ebp+0xc], 2` — arg2 is now 2, so this matches.
   - **0x1004585: `jnz 0x10045a4`** — since equal, falls through to LoadBitmapA at 0x1004596.
   - Loads bitmap (the undo-deck icon), draws it via BitBlt at (0x12d, 0x15) 32x32, cleans up.
   - **OPEN QUESTION:** Need to trace what happens after 0x10045fb — does the deal actually populate the card array, or does it return early?

5. **Card array** (0x1008ab0): Initialized to 0xFFFFFFFF (-1) for all 9×21 positions during WM_CREATE sub at 0x1001592. The WM_PAINT loop at 0x1003b7a treats -1 as "card back" (uses bitmap 0x34). But the rendered output shows green slots, not card backs — suggests the card-back bitmap (0x34 = 52) isn't drawing correctly either, OR the loop renders empty green instead of card-back for -1.

**Key addresses:**
| Address | Content |
|---------|---------|
| 0x1008010 | Game state flag (PE .data init=2; 0=?, 1=dealt?, 2=initial?) |
| 0x1008ab0 | Card array: 9 columns × 21 cards × 4 bytes, -1=empty |
| 0x1004520 | Deal/redraw function: (hdc, mode, forceFlag) |
| 0x1003a30 | WM_PAINT handler body |
| 0x1003b5c | Card-drawing loop (8 columns) |

**Next steps:**
- [ ] Continue disassembly at 0x10045fb to see if the deal populates the card array or returns early
- [ ] Check if the card-drawing loop at 0x1003b5c ever calls cdtDrawExt for each card slot when value=-1 (it may skip empty slots)
- [ ] Verify whether the fix should be: post WM_COMMAND(102) (New Game) to the message queue during startup, OR fix the deal function's state logic

**Related files:**
- `src/09a5-handlers-window.wat` — GetMessageA phases, ShowWindow WM_SIZE delivery, SendMessageA
- `src/09a-handlers.wat` — GetSystemMetrics, general API handlers
- `lib/host-imports.js` — gdi_bitblt, _getDrawTarget, GDI trace wrapping
- `test/run.js` — `--input` keypress injection (keydown/keyup/keypress already work)

## Input Injection

Keypress injection works via `--input` flag. Verified: F2 (VK=113) triggers New Game successfully.

```bash
node test/run.js --exe=test/binaries/entertainment-pack/freecell.exe \
  --input="50:keydown:113,50:keyup:113,80:png:scratch/freecell-f2.png" \
  --max-batches=100
```

Supported input types: `keydown:VK`, `keyup:VK`, `keypress:CHARCODE`, `click:X:Y`, `dblclick:X:Y`, `post-cmd:WPARAM`, `png:PATH`, and many more (see `test/run.js` lines 82-159).

## Known Issues / TODO

- **Initial deal doesn't render** — see root cause analysis above
- Game Over dialog (5020) only fires on actual win/lose detection inside the game loop. None of the Game menu commands trigger it mid-play (F2 / New Game silently deals a fresh game, Restart silently restarts, Exit closes the app). A test would require scripting a full winning move sequence for a known seed, or a losing state — both out of scope for a smoke test.
- Right-click auto-to-freecell is **not implemented in this binary**. The wndproc at 0x01001700 dispatches via a small jump table keyed on `msg - 0xf` and falls through to `DefWindowProcA` for anything it doesn't recognise — WM_RBUTTONDOWN (0x204) is in the fall-through range. This feature was added in XP's FreeCell, not the Entertainment Pack version.
- Help > Contents opens freecell.hlp (if present) via WAT-native help window; not part of the move regression
