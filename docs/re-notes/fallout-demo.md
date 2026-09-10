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

## Still To Verify

- Equipment dragging, conversation, combat and browser input acceptance.
- The lower-screen destination behavior described above.
- Native audio and the built-in F12 BMP screenshot path.

The first-area images establish actual movement, not complete demo acceptance.
