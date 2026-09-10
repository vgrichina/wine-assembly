# Fallout Win95 Interactive Demo

## Original Package

The `fallout-demo` candidate pins `falldemo.zip` from the Archive.org
`FalloutDemo` item (SHA-1 `214c6b8931f75aa2a9a11f521a26b0cb8e565ad9`).
Its original `Readme.txt` identifies Interactive Demo 1.0, 22 April 1997,
requires Win95 and DirectX 3.0+, and explicitly says there is no DOS demo.
This is not part of the deferred DOS work.

The original installation instructions specify unzipping into a directory,
preserving directory names, then running `FALLDEMO.EXE`. There is no game
installer to bypass in this package. The registered `fallout_demo` app mounts
`Falldemo.exe` and `Falldemo.dat`; startup also attempts the optional
`ereg\reg32a.exe` electronic registration program. No new package extraction
or guest byte patch was used for this investigation.

The original README and manual contain restricted preview-use terms, including
a ban on bundling with other products or services. Keep the local fixture
ignored; this investigation does not add it to a public distribution.

## Gameplay Route (2026-09-10)

The existing `test/test-les-flat.js` tests only the title plate after the
Watcom LES startup fix. A title screenshot does not establish gameplay.

The working controlled route uses frozen cooperative CLI execution,
100000-block batches and 10ms guest ticks. The original manual documents the
demo's one-minute inactivity reset, so the older 200ms/1000-block title-test
schedule is not a suitable assumption for interactive acceptance. An initial
probe with that schedule reached the menu but then faded without establishing
character selection or gameplay.

Ordinary keyboard input `N` enters New Game, `T` selects Take, and Enter
confirms the demo's default-character notice. The manual says only Max Stone
is playable in this demo, even when another character is selected. The game
then loads its outdoor map, with the player, NPCs, floating dialogue and the
native inventory/HP/action-point HUD visible. A left click at the initial
center movement hex makes Max Stone walk left. The first inspected captures
are `/private/tmp/fallout-game.png` and `/private/tmp/fallout-move.png`:
the blue-suit centroid moves from x=414.38 to x=324.69, well outside a cursor
or idle-animation-only change.

`node tools/run-fallout-gameplay.js` records this route using the registered
manifest, frozen stdio control, an internal 240-second guard and no build or
external timeout wrapper. It captures menu, character, demo notice and
before/after map frames under `build/fallout-gameplay`, checks the blue player
in the open-ground region and requires a substantial leftward move. It quits
the CLI and retains `run.log` on both success and failure.

## Relative Cursor And Inventory (2026-09-10)

Fallout draws its own movement cursor from DirectInput motion. In
`lib/renderer-input.js`, the first absolute `handleMouseMove` for a memory
instance establishes the previous point without emitting a delta. Thus one
absolute move followed by a click is not proof that a software cursor moved
to the requested point. The CLI's existing `relmousemove` supplies motion
directly; no runtime patch is necessary to move Fallout's cursor.

The cursor update must be observed before the next click. The extended driver
waits for the red hex at the destination, rather than assuming five slices
were sufficient. A live session then walked Max Stone back to his original
position, from x about 318 to blue-suit centroid 414.32. Its ordinary I key
opened the populated inventory, with weapons/ammunition, the character view,
empty equipment slots and Max Stone's statistics. Both
`/private/tmp/fallout-debug-back.png` and `fallout-debug-inventory.png` were
visually inspected.

Two lower-screen destinations, approximately (420,280) and (220,280), did not
produce movement. Waiting for the cursor, allowing the first walk to finish,
and comparing short/long presses did not change that. The built-in
`--trace-mouse-state` confirms the game polls both press/release edges at the
new coordinates. Returning to the known walkable initial position (420,240)
does work, ruling out a general second-command failure. Do not label the
lower destinations walkable, or declare a pathfinding defect, without checking
the demo's actual map/collision data or a reference run.

The extended driver passes without tracing: sprite centroids
414.38 -> 324.69 -> 414.32, followed by the inventory statistics-panel gate.
Its `right.png` and `inventory.png` captures were visually inspected. The
CLI exits 0; no runtime changes or input-state patches are used.

## Browser Equipment And Combat (2026-09-10)

An isolated headless Chrome run at `55b945cb` launches the registered
`fallout_demo` through the actual page shell. Threads is off, Frozen is on,
the slice budget is 100000 blocks and `WineFrozen.step(n, 10)` supplies guest
time. Only Puppeteer keyboard/mouse events drive gameplay; no guest bytes,
input state, or scheduler clocks are patched. Pointer Lock remains false:
ordinary browser moves after the first point generate the needed DI deltas.

The page viewport is 1000x760, with `#screen` at (10,192), size 660x530.
The 640x480 game is fitted inside it with vertical bars above/below. Coordinates
below are browser client pixels for this viewport, not native game pixels.

Verified route:

1. Step 1500; N down/10/up/200 reaches character selection at 1710.
2. T down/10/up/400; Enter down/10/up/1000 reaches the map at 3130.
3. Move to (340,457), left down/10/up/200: walk left, captured at 3340.
4. Move to (443,457), step 100, left down/10/up/500: return to the initial
   area at 3950. I down/10/up/150 opens inventory at 4110.
5. Move to (170,267), step 100, left down/20; move to (295,535), step 100,
   left up/150: MP9 is in Item 1 at 4480. The stats show damage 5-12,
   range 25, and 30/30 rounds of 10mm JHP. The weapon leaves the carried list.
6. Move to (170,267), step 50, left down/20; move to (295,430), step 50,
   left up/100: armor is equipped at 4700. The character model changes and
   armor class becomes 27.
7. Escape down/10/up/150 starts closing inventory. An attempted Done click
   (550,555), after 100 move steps, down/10/up/300, did not immediately clear
   the inventory. Another 2000 steps reaches the equipped map at 7270.
8. Move to weapon button (360,655), step 100, left down/10/up/100. Move to
   the townsman at (270,370), step 100: targeting shows 43% at 7580.
9. Left down/10/up/500 fires at 8090. The native message reports hitting a
   wooden wall instead of the townsman for 8 hit points, and combat turn
   controls appear. This verifies a combat action, not a defeated enemy.

The temporary bounded stdin probe is `/private/tmp/fallout-browser-check.js
--isolate`; its log is `/private/tmp/fallout-browser-check.log`. It exits 0,
closes its browser/server, and reports no RuntimeError, unimplemented API or
abandoned callback. Visually inspected frames include
`/private/tmp/fallout-browser-{map,walk,return,inventory,equipped,armored,after-wait,target,combat}.png`.

The apparent inventory-close stall was investigated through the existing
`tools/ctl.js -s SESSION --hub=URL eval ...` against the live browser.
EIP `0x075000d0` is the `timeGetTime` thunk (API 826), returning to
`0x004873cd`. The helper at `0x004873c4` returns whether the clock differs
from saved value `0x0062f7a8`; `0x00487420` counts those changes, and its
caller returns to UI animation code at `0x0043e2c8`. Guest time and saved time
both advanced; there were no sleeping threads, wait handles or synchronous
message depth. More steps completed the transition, so the sampled thunk
alone is not evidence of a hung clock or missing assets. Its exact transition
duration has not been characterized.

## Still To Verify

- Conversation and a complete enemy turn/continued combat sequence.
- Worker-backend and mobile input acceptance.
- The lower-screen destination behavior described above.
- Native audio and the built-in F12 BMP screenshot path.

The first-area images establish actual movement, not complete demo acceptance.
