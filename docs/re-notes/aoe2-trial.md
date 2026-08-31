# Age of Empires II Trial

## Verified state (2026-08-26)

`binaries/shareware/aoe2/aoe2_ex/EMPIRES2.EXE` now reaches live Random Map
gameplay through the registered `aoe2` app on the same asset manifest used by
the web host. The verified frame contains villagers, a town center under
construction, explored terrain and fog, the resource bar, command panel, and
minimap. `test/test-aoe2-gameplay.js` reproduces first run and checks the frame.

## Web clean-exit cause

The old app entry mounted 25 files. It included the core DRS archives and
`language.dll`, but omitted `EBUEula.dll`. The trial loads that DLL dynamically,
so it is not listed in the EXE import table. A local CLI run could find the
sibling file from the checkout; the web VFS could not, and `EMPIRES2.EXE`
returned through `ExitProcess(0)` before creating the main game window. The
clean status made this look like a successful smoke run.

The same manifest also omitted the files enumerated only after player creation:

```text
FindFirstFile("campaign\\*.cpn")
FindFirstFile("scenario\\*.scn")
```

Both searches failed even though the trial payload ships `campaign/cam8.cpn`
(the embedded William Wallace scenarios) and the coastal-map scenarios.

## Player-name field

The new-player EDIT accepted characters but looked blank during typing. API and
surface traces showed each prefix reaching the native control and being painted
into the top-level GDI surface. The exclusive compositor subsequently placed an
opaque DirectDraw frame layer over it. AoE I uses the same subclassed-native-
EDIT arrangement and exhibited the same rendering bug.

The renderer now retains that otherwise-suppressed GDI surface and composites
only visible native-child rectangles above DirectDraw. This keeps the game
frame authoritative outside the child while making the live name and caret
visible. Retention is intentionally independent of whether the child already
exists: in browser worker mode the surface attachment can arrive before the
later `CreateWindow(EDIT)` host notification. The focused regression creates
the child after both surfaces, and the AoE II acceptance captures `Codex`
before clicking OK and rejects the old uniformly black field.

## EULA text

The trial passes RichEdit `EM_STREAMIN` an `EDITSTREAM` whose `dwCookie` is
opaque state and whose `pfnCallback` supplies `EULA.RTF`. The control shim had
treated `dwCookie` itself as a C string and ignored the callback, so the dialog
created a correctly sized but empty text box.

The edit control now invokes the documented guest callback synchronously,
streams bounded chunks, reports callback errors through `dwError`, and projects
visible RTF text into the native control while dropping formatting destinations
such as font/color tables and pictures. The real web EULA streams 6,449 bytes
and displays 4,793 visible characters. `test/test-richedit-stream-callback.js`
covers both direct-cookie compatibility and a real x86 stdcall callback.

## Camera-pan terrain rectangles

Holding a camera key into unexplored fog exposed repeated 24x32 terrain islands
in both AoE I and AoE II. They were not compositor overlays or bad texture
coordinates. DirectDraw traces identified the rectangle as the game's software-
cursor background surface:

```text
Blt render <- saved background    (restore old cursor rectangle)
Blt saved background <- render    (save new cursor rectangle)
Blt primary <- render             (present frame)
```

AoE CPU-redraws the render surface through `Lock`/`Unlock` before the first
restore. Replaying the prior frame's saved background therefore stamps obsolete
terrain onto the new world; subsequent camera motion carries each stamp across
the fog. DirectDraw now records bounded small-surface save provenance and a
per-surface CPU-write epoch. Only an exact inverse restore whose source surface
was saved before a later `Unlock` becomes a successful no-op. Same-epoch cursor
erase and non-inverse surface copies still execute normally.

The focused DirectDraw regression covers all three cases. The AoE II acceptance
also holds Left through gameplay and checks the central fog band: the broken
frame contained 1,800 colored pixels in repeated islands; the fixed CLI and web
captures contain none.

## Manifest and acceptance route

`lib/apps.js` now mounts 95 required files (68.8 MiB): the EULA DLL/document,
core data and fonts, the complete trial campaign media/audio, both loose trial
scenarios, and MIDI music. `requiredFiles: true` turns a missing payload file
into a launch error instead of silently exposing empty gameplay choices.

The acceptance route is:

```text
EULA Accept -> Single Player -> create player -> Random Map -> Start Game
  -> Trial Coastal Map -> OK -> live map
```

With 50,000 interpreter steps per batch and 100 ms of guest time per batch, the
first terrain-and-HUD gameplay frame is stable by batch 1600. The test requires
a 640x480 capture with a substantial green terrain region, detailed world
pixels, and the dark lower command/minimap HUD; it also rejects clean early
`ExitProcess` as a failure. It then pans from batch 1602 through 1640 and rejects
stale cursor-background rectangles in the fog.
