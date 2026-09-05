# Broken Sword demo

## Binary and launch layout

- Executable: `Broken_Sword_demo-SW/WINSWORD.EXE`
- SHA-256: `8ca6e3f0c56e1f289f79e2d52ca8cd98466c5b5c2817b3d05b7f7d80425c4177`
- Native video decoder: `SMACKW32.DLL`
- High-quality opening movie: `SMACKSHI/INTRO.SMK` (13,298,480 bytes)
- Low-quality opening movie: `SMACKSLO/INTRO.SMK` (10,717,968 bytes)

The browser manifest contains 551 files totaling about 158 MB. The launcher
fetches all of them before starting the guest. In single-app/full-page mode the
canvas is black during this load, while the progress text remains outside the
game canvas; on a local Chrome run it was still fully black 12 seconds after
launch and showed a decoded frame by 40 seconds. This interval is asset loading
and initial Smacker decode, not a dead DirectDraw surface.

## Opening movie evidence

A 15-second renderer-enabled CLI run at `--batch-size=200000` decoded the high
quality `INTRO.SMK` and captured a normal Paris credits frame. During playback
WINSWORD repeatedly calls `IDirectDrawSurface_Lock` and
`IDirectDrawSurface_Unlock` on the primary surface at `0x07efe008`; every unlock
presents a newly written 640x480 8-bpp surface. The final surface census found
195 sampled colours and non-zero pixels. A browser run also became non-black
without changing the decoder or DirectDraw path.

The old registry `startupInput` Escape entry was added when the preload period
was mistaken for an intro that never presented. It is not evidence of a codec
failure: the actual movie renders after the payload is ready.

## Cursor behavior

This was checked against the corpus executable, not inferred from another
engine or release. In `WINSWORD.EXE` the window-class setup at `0x00401266`
loads `IDC_ARROW`. Its WndProc at `0x00401033` handles `WM_SETCURSOR` at
`0x0040111f` by calling `SetCursor(NULL)` and returning 1. That is the only
`SetCursor` call in the executable.

The missing system pointer is intentional because WINSWORD owns a software
cursor:

- `WM_MOUSEMOVE` at `0x004011d8` passes the raw client coordinates to
  `0x0041486f`, which stores them in the mouse state rooted at `0x004387e4`.
- `0x00407a96` selects cursor resources; zero clears the pointer, while
  `0x04010000` is the default arrow and the following resource IDs are its
  context-sensitive variants.
- `0x004073da` enables mouse input and selects that default resource.
- `0x00414680` locks the DirectDraw surface, composites the cursor pixels at
  the current coordinates, and unlocks it for presentation.

A deterministic CLI run reached café gameplay with resource `0x04010000` and
the software arrow at `(320,240)`. Moving to real hotspots changed it to the
magnifier and gear; clicking did not clear it, and moving away restored the
arrow. Therefore a cursor that disappears after a click is a host input or
surface-publication defect, not intended WINSWORD behavior.

The browser/system cursor must remain hidden while this software cursor is
active. Win32 defines a NULL `SetCursor` independently of the signed
`ShowCursor` display count. The host previously mapped handle zero through its
unknown-ID fallback to CSS `default`, causing the normal arrow to appear over
the game cursor.
