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
manifest, frozen stdio control, an internal 180-second guard and no build or
external timeout wrapper. It captures menu, character, demo notice and
before/after map frames under `build/fallout-gameplay`, checks the blue player
in the open-ground region and requires a substantial leftward move. It quits
the CLI and retains `run.log` on both success and failure.

## Still To Verify

- General mouse positioning: absolute clicks at non-center coordinates did
  not move the game's drawn cursor to those coordinates. Button input does
  reach the game and initiates movement to its current hex. Test its relative
  input path before assuming that the button itself is broken.
- Inventory/equipment, conversation, combat and browser input acceptance.
- Native audio and the built-in F12 BMP screenshot path.

The first-area images establish actual movement, not complete demo acceptance.
