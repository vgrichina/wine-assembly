# Little Fighter 2 v1.9

Local-only app ids `little_fighter_2` and `little_fighter_2_installer`.
The pinned original installer is
`test/binaries/candidates/little-fighter-2-installer/lf2_v19.exe`; a prepared
browser payload lives below that directory at `installed/` and remains
gitignored.

## Provenance and license boundary

- Package: Little Fighter 2 v1.9, dated 27 September 2002.
- Installer SHA-256:
  `1e4e93510fc47ac636c918cdde97c645e02bcac611ec9d3181f4ecaf9733b819`.
- Installed `lf2.exe` SHA-256:
  `41ee2d29f41eb8e6975d14b42922fe40481d40c6b11eb7a2c6b239fbc578f251`.
- The [official introduction](https://www.lf2.net/en/intro.html) calls LF2 a
  freeware Windows game, and the [official FAQ](https://www.lf2.net/faq_en.html)
  says its authors intended people to play it free of charge.
- The installed readme says copyright 1999-2002 Marti Wong and Starsky Wong,
  **All rights reserved**. Neither that readme nor the official pages inspected
  grant redistribution rights. Freeware is a price classification, not an
  open-source or redistribution license.

Therefore the package is allowed as a local compatibility fixture under the
project's freeware/shareware/demo policy, but neither installer nor installed
assets are public deployment inputs. Revisit this only with an explicit grant
from the rights holders.

The installed readme explicitly requires Windows 95/98, DirectX 6, at least
800x600, and 16-bit colour, making this exact build a valid Win98 target.

## Native installer path

The unchanged installer completes in `test/run.js`. Its rendered wizard path
is:

1. `Install Program - Welcome`: click `(490,469)`.
2. `Install Program - Directory`: accept the default directory at `(490,469)`.
3. `Install Program - Confirmation`: click `(490,469)`.
4. Wait for `Install Program - End`, whose body reports that v1.9 was
   successfully installed.

At `--batch-size=10000` the end page appears around batch 5068. Use
`wait-title-dump-stop` there: leaving the completed installer alive used to
make the harness wait until its outer timeout even though installation had
already succeeded. `test/test-little-fighter-2-candidate.js` now stops on the
end page, exports the VFS, validates the executable/readme/background, and
checks the exact installed executable hash.

Set `PREPARE_LF2_DEBUG_WEB=1` while running that test to copy the installed
game into the ignored `installed/` directory and write its
`.wine-assembly-browser.json` file. The preparation step then applies the same
reduced `data/data.txt` compatibility profile described below; all referenced
executables, sprites, sounds, objects, and backgrounds remain byte-for-byte
installer output.

## DirectDraw failure and fix

LF2 creates a 794x548 backbuffer and blits it to a 640x480 primary surface at
destination `(23,43)`. The equal-size `IDirectDrawSurface::Blt` path previously
treated this as an unchecked memcpy. It wrote beyond the destination DIB and
corrupted adjacent WASM memory.

Commit `0af6a0cf` clips source and destination rectangles as a paired operation
against both surface bounds. `test/test-directdraw-blt-clipping.js` covers
negative origins and an oversized positive destination. With that fix LF2's
title, menus, sprites, HUD, and arena compose normally.

The stock object index loads 134 live sprite surfaces and exhausts the current
63 MiB DirectDraw DIB arena. The gameplay regression and selectable local app
use every file produced by the original installer but replace `data/data.txt`
with an index containing three stock fighters, their projectile dependencies,
common weapon objects, and the stock Hong Kong background. This separates
gameplay compatibility from the independent DirectDraw-capacity limit. It is a
playable compatibility profile, not a claim that the complete stock roster
fits yet.

## Deterministic gameplay route

Run the candidate gate with the CLI build already present:

```bash
node test/test-little-fighter-2-candidate.js
```

The game phase uses `--control-stdin --frozen --max-seconds=600`. It issues
short stepped bursts and sleeps briefly between them, so the process blocks on
stdin with zero emulator work between bursts instead of monopolizing a core.
The verified route is:

1. Move to `(400,313)` before clicking the title. LF2 samples hover state, so a
   bare click without the preceding mouse move is ignored.
2. Select VS mode with P3 Enter.
3. Join/select P3 with Enter and P2 with `S`.
4. Choose one CPU player, select its random fighter/team, move the overlay
   highlight up twice to **Fight**, and confirm.
5. Hold P3 Right and Attack in the arena.

The two final 800x600 captures must each exceed 1,000 colours and 400,000
nonblack pixels, and movement/attack must change at least 50,000 pixels. They
are written to `build/little-fighter-2-candidate/gameplay-a.png` and
`gameplay-b.png`; the installer completion frame is retained beside them.
