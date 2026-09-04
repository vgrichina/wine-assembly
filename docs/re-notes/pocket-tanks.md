# Pocket Tanks v1.6 shareware

Local-only app ids `pocket_tanks` and `pocket_tanks_installer`. The pinned
original installer is
`test/binaries/candidates/pocket-tanks-installer/ptanks.exe`; an optional
prepared browser payload lives below that directory at `installed/` and remains
gitignored.

## Provenance and license boundary

- Official page: <https://classic.blitwise.com/pockettanks.html>.
- Official installer: <https://classic.blitwise.com/ptanks.exe>.
- Installer SHA-1: `1f10dd5830eecf117bc10daf7e85d29f364dbdc2`.
- Installer SHA-256:
  `a3d7da899ab2d3cdd33c6b10747478628175c5a5e0c215eb43a629e6cf98c982`.
- The publisher identifies this edition as shareware. That status makes it a
  valid local compatibility fixture under the candidate policy, but is not by
  itself an open-source license or an unconditional public redistribution
  grant. Keep both installer and installed assets out of public deployment
  until the package terms are reviewed for that specific use.

## Native installer path

`ptanks.exe` is a bootstrap rather than the final wizard. It writes a generated
Inno Setup child beneath `C:\windows\temp` and launches it with a package-specific
`/SL4` command line. `test/test-pocket-tanks-candidate.js` uses
`--capture-launch` to snapshot that child and its exact argument string from the
guest VFS, then starts the captured child with the original bootstrap mounted at
`C:\ptanks.exe`.

This is not host extraction. Both executable stages run in Wine-Assembly; the
host receives an installed VFS only after the guest installer reaches its
completion page. The test verifies that the resulting payload contains both
`pockettanks.exe` and `ptloader.exe`.

The Inno Install button must be delivered through the normal mouse input queue.
Calling its window procedure directly from control-channel `eval` starts the
first extraction operation but loses the yielded continuation. A queued click
at `(515,467)` keeps that continuation owned by the guest run loop and completes
the installation.

Set `PREPARE_POCKET_TANKS_DEBUG_WEB=1` while running the test to copy the
emulator-installed game to the ignored `installed/` directory and generate its
`.wine-assembly-browser.json` manifest.

## Frozen gameplay route

Run the end-to-end candidate gate with the CLI build already present:

```bash
node test/test-pocket-tanks-candidate.js
```

The game phase uses `--control-stdin --frozen`. It runs short explicit step
bursts and blocks on stdin with no emulator work between commands. The route is:

1. Poll screenshots until the Deluxe offer has finished loading, then click
   **Maybe Later**.
2. Click **Start** on the title screen.
3. Capture the mode menu and click **Target Practice**.
4. Poll for the red `PLAYER 1` HUD, which distinguishes the battlefield from
   the stopwatch loading frame.
5. Capture the battlefield, click **Fire**, and capture the changed frame.

The two final 800x600 frames must contain substantial game art and differ after
the shot. They are written to
`build/pocket-tanks-candidate/gameplay-a.png` and `gameplay-b.png`; the original
installer completion frame is retained beside them.

Pocket Tanks uses the legacy BASS API. Wine-Assembly's compatibility handlers
let this shareware build reach visual gameplay when that historical audio DLL is
not available, but this gate does not claim working game music or sound effects.
