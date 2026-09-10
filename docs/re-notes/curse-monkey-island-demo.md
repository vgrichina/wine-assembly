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
The top artwork panel was blank in that capture and needs investigation.
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

Inventory and verb-coin interaction remain outside this regression. The
README documents right-click inventory and a held left-click verb coin;
those require additional interactive acceptance before claiming coverage.
