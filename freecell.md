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
- **Initial deal rendering:** all 52 cards visible

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

## Known Issues / TODO

- Game Over dialog (5020) only fires on actual win/lose detection inside the game loop. None of the Game menu commands trigger it mid-play (F2 / New Game silently deals a fresh game, Restart silently restarts, Exit closes the app). A test would require scripting a full winning move sequence for a known seed, or a losing state — both out of scope for a smoke test.
- Right-click auto-to-freecell is **not implemented in this binary**. The wndproc at 0x01001700 dispatches via a small jump table keyed on `msg - 0xf` and falls through to `DefWindowProcA` for anything it doesn't recognise — WM_RBUTTONDOWN (0x204) is in the fall-through range. This feature was added in XP's FreeCell, not the Entertainment Pack version.
- Help > Contents opens freecell.hlp (if present) via WAT-native help window; not part of the move regression
