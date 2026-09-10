# The Curse of Monkey Island demo

The local original demo comes from the Windows 98 A-D distribution linked
in `sources.md`. The package and playable files remain local-only.

- `COMI.EXE` SHA-256:
  `b55524231edacc7d184c22c762d25193d616adc55d0141785fb21b8890d352b9`
- `CURSE.EXE` SHA-256:
  `b635bef2e58c91faa9592ea19200ffa031a44e8d55a4cd62245e392aef3683f3`

The bundled README identifies demo 1.0 and requires Windows 95, a Pentium,
16 MB RAM, CD-ROM, and a mouse. `CURSE.EXE` is the original launcher: a real
emulated launch displayed Play, Install DirectX, Readme, Troubleshooting,
and Exit. It reached the child-launch yield without a game-copy wizard.
The top artwork panel was initially blank; the etched-static fix below
restores it.
The registered app runs `COMI.EXE` with the original 11 companion files.

## Functional acceptance

`test/test-comi-gameplay.js` uses the frozen headless CLI, skips the opening
dialogue with Escape, and clicks the hold floor at `(250,390)`. Before and
after screenshots show Guybrush standing at the right wall and then walking
toward the center. The test measures his distinctive cream-shirt palette
pixels, requiring a leftward displacement greater than 60 pixels, rather
than counting cannon animation or mouse-cursor changes as player movement.
The verified run measured x=438 to x=335 and exited cleanly.

Screenshots are written to `COMI_SCREENSHOT_DIR` or the temporary directory
`wine-assembly-comi-gameplay`. The test pins the original executable hash;
its palette assertion is specific to that demo and scene.

The regression also right-clicks to open the inventory chest, closes it,
then holds the left button over the small pirate to open the verb coin.
Both captures were visually inspected. Region-specific brown chest and
gold coin pixel thresholds assert those controls appeared; selecting a
verb and completing the demo's puzzle remain unverified.

## Launcher artwork investigation

The blank panel is not evidence of an absent bitmap resource. `CURSE.EXE`
contains bitmap resource 184, and its launch trace calls `LoadImageA` for
that resource with dimensions 240x197 and `LR_CREATEDIBSECTION`, followed
by a successful `BitBlt` into the dialog at `(0,3)`. A static child occupies
the same rectangle. Trace control paints and DC targeting before deciding
whether loading, rasterization, or a later repaint loses the artwork.

The resource header is a 40-byte BITMAPINFOHEADER: 320x240, 8bpp,
BI_RGB, 76800 pixel bytes (raw PE offset `0x2cefc`). The overlapping
dialog-102 static is control 1003, style `0x50000012`, not SS_BITMAP.
`--trace-ctrl` confirms it paints at screen `(199,77)` with extent 240x197.
The LoadImage result selected into the source DC is nonzero (`0x410005`).
These observations narrow the next probe to actual bitmap pixels and
destination/repaint behavior; a successful BitBlt return alone does not
prove visible rendering. The bounded 80-step probe exits cleanly.

### Etched frame fix

The cause was static-control painting: a four-bit type mask changed
SS_ETCHEDFRAME (`0x12`) into SS_RIGHT (`0x02`), then its text-label fill
erased the parent's artwork. Preserve five type bits and handle etched
horizontal, vertical, and full frames with EDGE_ETCHED and the appropriate
border flags, without BF_MIDDLE. This follows the
[static-control style contract](https://learn.microsoft.com/en-us/windows/win32/controls/static-control-styles).

`test/test-static-bitmap-control.js` seeds colored interior pixels and
checks all three etched styles across repeated paints, including which
edges change. It failed gray before the fix and passes afterward, alongside
the existing resource/dynamic bitmap coverage. The original launcher now
shows the moon, sea, and Guybrush in his boat; its capture was inspected.
The art region changed from zero to 38238 chromatic pixels. Canonical and
compat builds pass, as does the full COMI movement/inventory/verb-coin test
against the new build. This verifies artwork presence, not exact LoadImage
scaling fidelity or every launcher button.
