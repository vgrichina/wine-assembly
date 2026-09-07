# Worms 2 October demo

Local app id `worms2_demo`. The original setup media is prepared beneath
`test/binaries/candidates/worms-2-demo/installer-10oct/`; any installed browser
payload remains local and gitignored.

## Provenance and terms

- Source page: <http://www.classicdosgames.com/game/Worms_2.html>
- Direct original ZIP:
  <http://www.classicdosgames.com/files/games/team17/Worms2Demo10Oct.zip>
- ZIP size: 7,299,379 bytes.
- ZIP SHA-1: `30d3c4858cc99c412a21085e1740bd7ca9123a8a`.
- ZIP SHA-256:
  `c65d36cef69437f066a3d50d8ff26d43d228a0595d7bcc106d541375e1d3cfd8`.
- Original `SETUP.EXE` SHA-256:
  `795c2f00a669bdbcea105402c5341a1efecdb7d4e64d0a4d8d9ab3d509649e12`.

The installed README identifies the package as demo release 1.1 dated October
9, 1997. It explicitly permits redistribution when the original files remain
intact and unchanged. Wine-Assembly records links and hashes for that original
distribution; the downloaded installer and installed payload remain local
candidate fixtures rather than committed project assets.

The README also says this smaller demo has no music. Its audio evidence is the
installed DirectSound effects and speech, not a missing soundtrack.

## Installer route

`SETUP.EXE` is the original Win16 InstallShield bootstrap. It reads the
unchanged source media, writes `_INS####._MP` and `zdatai50.dll` beneath
`C:\WINDOWS\TEMP`, records its native options in `_INS####.INI`, and launches
that 32-bit engine. The emitted engine hashes to
`a4caeb938fcb6bef335af1855f582e699d7fb9b4368de01c01a06e8fafc784cf`.

`test/test-worms2-candidate.js` runs that bootstrap in Wine-Assembly and uses
`--capture-launch` before the bootstrap deletes its temporary child. The test
relocates only those emulator-produced engine/INI files beside the captured
source media so the next CLI process can mount the same `C:\` layout. It does
not open or extract an InstallShield cabinet on the host. A stdio controller
lets the guest run only while advancing between Welcome, destination, program
folder, copy, and Setup Complete; it parks at every page and clicks Finish.
The stock engine's final generic labels still show literal `%p`/`%e` template
tokens even though the package's `SETUP.INS` contains the expanded Worms-specific
completion strings. This is a remaining cosmetic InstallShield fidelity issue;
it does not affect the completed copy, Finish exit, or installed payload.

The resulting `C:\Team 17\Worms 2 Demo` tree has 158 files, including 140 WAV
files. Stable installed hashes are:

| File | SHA-256 |
|---|---|
| `worms2.dat` | `cfb393c9ae72764dd4ff85b3e679671d28017d59d5c4b852d64bee7597447caa` |
| `data/land.dat` | `d9efd28af0605566cd67f3f74b857870eb2e4fc18333fe519f6503f90d9eaeb2` |
| `data/gfx/gfx.dir` | `ac79437346dfbb00e3e22998e0dbeb356c233798bbc6cc73d27ab3ddb63bff7a` |
| `data/level/medieval/level.dir` | `02f0f1b03d3ad1d1bf279ff9decbcbdd204031452cd75351ca44b6609c396b22` |

InstallShield generates `uninst.isu` per installation, so its hash is not a
payload identity check.

## Gameplay route

Despite its extension, `worms2.dat` is the native PE32 game.
`worms2demo.exe` is a promotional wrapper which eventually calls
`CreateProcessA("worms2.dat", ...)`; the one-process browser runtime therefore
launches the installed game PE directly.

With `--tick-ms-per-batch=5`, the installed game reaches its live two-player
medieval match before the 60-second turn timer races ahead. The candidate gate
parks at gameplay, holds Left to walk Fudge off the starting shore, and captures
the resulting drowning animation. It requires more than 100,000 changed pixels,
a colorful 640x480 8-bit DirectDraw primary surface, and nonempty DirectSound
voice bytes.

Screenshots are written to `build/worms2-candidate/`:
`installer-finished.png`, `gameplay-a.png`, and `gameplay-b.png`.
