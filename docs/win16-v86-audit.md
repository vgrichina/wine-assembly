# Win16 native Windows 98 visual audit

Audit date: 2026-08-22

This audit compares every Win16 application registered in `lib/apps.js` with
the same binary running natively in the pinned Windows 98 v86 reference.  The
scope is 33 launchable applications: the four Windows 98 games and the 29
Entertainment Pack entries.  The `.IW` files are IdleWild modules rather than
standalone applications, so they are exercised through IdleWild and are not
double-counted as apps.

The complete contact sheet is produced locally at
`test/output/win16-v86-comparison/contact-sheet-all.png`; generated audit
artifacts under `test/output/` are not published with the site.
Every pair places native Windows 98 on the left and wine-assembly on the right.
Native metadata, payload hashes, full-size PNGs, and local transcripts live in
the corresponding per-app directory.  All full-size pairs were inspected
manually; automated launch or pixel-count results were not accepted as visual
proof.

## Interpretation

These are expected and are not classified as defects:

- Native v86 is pinned to 640x480x4 VGA, so arbitrary RGB colors can map to a
  16-color palette or dither while wine-assembly retains the source RGB.
- Independent random deals, timers, and persisted card-back preferences differ.
- The native taskbar consumes the bottom 28 pixels; wine-assembly's CLI capture
  uses the complete 640x480 canvas.
- `CW_USEDEFAULT` window positions can cascade differently.

Twenty-nine apps produced fresh native/local pairs.  Four current local runs
did not produce a new screenshot: Hearts crashes, while TriPeaks, Go Figure,
and Tic Tac Drop exceeded the bounded CLI capture.  For those four, a
`last-known-side-by-side.png` pairs the fresh native image with the most recent
successful local artifact.  Those files are visibly and explicitly named
“last-known”; they are not evidence that the current runtime still works.

## Confirmed defects

| Priority | App | Native comparison result |
|---|---|---|
| P0 | Hearts | Current CLI and browser launch both trap at guest `EIP=0x00109b63`, immediately after creating the main window. Native reaches the welcome/player dialog. The previous local dialog was visually close, but is now only last-known evidence. |
| P1 | Go Figure! | Last-known local rendering has corrupted VBX captions, vertical garbage text in the level gauge, blank white fields where native draws disabled controls, and malformed top-row labels. A shorter current startup-only run also exceeded 300 seconds. |
| P1 | Tic Tac Drop | Last-known local board art is present, but the four toolbar labels/combo values are blank or rendered as repeated garbage such as `[]Hev`; native shows Rows, Columns, Win Pattern, Level, and their values. The current run remains inside first-batch control creation for more than 120 seconds and misses a 300-second capture. |
| P1 | IdleWild | Native selects and displays `Blackness`; local paints an empty list and gray preview panel. Animated screen pixels also leak behind/through the control area instead of remaining in the native preview composition. |
| P1 | WordZap | Native draws the large yellow lightning bolt between WORD and ZAP. Local omits it completely while rendering the surrounding letters and copyright text. This is missing artwork, not a palette remap. |
| P1 | Tetris | Behind the About dialog, local shows a blank gray field and `??????` where native paints the magenta tiled playfield and score panel. The About package logo is also black in local versus the native embossed white resource. Gameplay after closing About has separate action coverage, so this is specifically a startup/paint defect. |
| P1 | Klotski | The local welcome dialog is roughly three times the native width, and the copyright banner is clipped to its trailing text. Native shows the complete ZH logo/banner and compact centered dialog. |
| P2 | Rattler Race | The local six-digit score display is narrowed to roughly two visible digits; native shows the complete `000000` field. The animated title/gameplay otherwise renders. |
| P2 | Fuji Golf | After accepting native's documented first-run data-copy prompt, native opens a maximized clubhouse with the full-height 368x326 scene. Local opens a smaller non-maximized window and vertically compresses/crops the clubhouse scene. |
| P2 | JigSawed/Tetris About artwork | Both local About dialogs render the Entertainment Pack logo as solid black where native uses the embossed white/gray form. JigSawed gameplay itself now matches the native hollow target and scrollbars; this is a shared About-resource rendering defect. |
| P2 | TriPeaks performance audit | Native dismisses the name dialog, deals, and renders the full tableau promptly. The current local audit did not reach its matched post-F2 screenshot inside 300 seconds, although the earlier action regression passed and the last-known startup dialog is geometrically close. Recheck under low load before assigning a functional root cause. |

The debug launcher also had three inventory errors found by the completeness
check: `wep16_tp` was labeled “TriPeaks” instead of “Taipei,” and Fuji Golf and
Tic Tac Drop were absent.  The audit changes correct those three exact option
lines and add a regression requiring all 33 registered apps to be selectable.

## Complete 33-app matrix

| App | Fresh pair | Manual verdict |
|---|---:|---|
| FreeCell (Windows 98) | yes | Acceptable; initial deal geometry and cards match. |
| Solitaire (Windows 98) | yes | Acceptable; full deal renders. Card-back/deal differences are persisted settings/RNG. |
| Minesweeper (Windows 98) | yes | Acceptable; frame, counters, face, and grid match. |
| Hearts (Windows 98) | no | **Broken now:** deterministic startup crash; last-known dialog comparison retained. |
| Cruel | yes | Acceptable; populated tableau and controls match apart from deal/palette. |
| Golf | yes | Acceptable; tableau geometry and card rendering match apart from deal. |
| IdleWild | yes | **Broken:** missing selected-module text and preview/control composition. |
| Pegged | yes | Acceptable; board, pegs, menus, and geometry match. |
| Tetris | yes | **Broken startup paint/About resource**, despite separate gameplay coverage. |
| TicTactics | yes | Acceptable; 3-D board and initial piece match. |
| Taipei | yes | Acceptable; splash geometry/artwork match. |
| Minesweeper (Entertainment Pack) | yes | Acceptable; counters, face, and grid match. |
| FreeCell (Entertainment Pack) | yes | Acceptable; initial state matches. |
| JigSawed | yes | Gameplay fixed; remaining About-logo polarity mismatch. |
| Pipe Dream | yes | Acceptable; board/splash/queue geometry match. Preview palette differs under 4-bit VGA. |
| Rattler Race | yes | **Broken score control width**; title/game field otherwise present. |
| Rodent's Revenge | yes | Acceptable; board and controls match, with expected 4-bit palette mapping. |
| Stones | yes | Acceptable; field/sidebar match, with randomized stones. |
| Tut's Tomb | yes | Acceptable; full card pyramid and status match. |
| Fuji Golf | yes | **Broken maximized/window and scene-height geometry.** |
| Klotski | yes | **Broken welcome-dialog geometry and clipped banner.** |
| LifeGenesis | yes | Acceptable; grid size and menu/frame match. |
| SkiFree | yes | Acceptable; title/start controls and status match. |
| TetraVex | yes | Acceptable; board/tile geometry match, with randomized values. |
| TriPeaks | no | Last-known startup visual is close; current matched deal capture times out and needs performance isolation. |
| WordZap | yes | **Broken:** central lightning artwork missing. |
| Dr. Black Jack | yes | Acceptable matched dealt-hand state; cards/controls are populated. |
| Chess | yes | Acceptable; board, pieces, auxiliary windows, and controls match. |
| Chip's Challenge | yes | Acceptable; lesson board, sprites, counters, and password panel match. |
| Go Figure! | no | **Broken:** malformed VBX controls/text plus current capture timeout. |
| JezzBall | yes | Acceptable; arena, balls, status, and grid match. |
| Maxwell's Maniac | yes | Acceptable; live chamber renders. Layout/ball positions are randomized. |
| Tic Tac Drop | no | **Broken:** malformed toolbar/combo text plus current capture timeout; board art itself matches. |

## Reproduction

```sh
node tools/win16-v86-compare.js --online
node test/test-win16-v86-audit.js
```

The comparison driver supports `--only=id,id`, `--reuse`, `--native-only`, and
`--local-only`.  Native capture batches boot Windows 98 once and restore the
same pristine saved state before each application, so a previous app cannot
contaminate the next capture.  Each ISO contains the app's recursive NE import
closure plus only its registered runtime/data/help files; mounting an entire
Entertainment Pack volume would overflow the reference ISO root and would also
weaken dependency evidence.

## Next fix order

1. Hearts startup crash, because the app is completely unavailable.
2. The shared VB/VBX control-caption path visible in Go Figure and Tic Tac Drop.
3. IdleWild module list/preview and WordZap's missing lightning artwork.
4. Shared dialog/bitmap geometry issues in Klotski, Tetris About, and Fuji Golf.
5. Rattler's numeric control width and the low-load TriPeaks performance rerun.
