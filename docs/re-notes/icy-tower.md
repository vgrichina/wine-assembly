# Icy Tower v1.3.1

Local app ids `icy_tower` and `icy_tower_installer`. The pinned original
installer is `test/binaries/candidates/icy-tower/icytower13_install.exe`; the
optional installed browser payload is beneath that directory at `installed/`
and remains gitignored.

## Provenance and distribution terms

- Archive page: <https://archive.org/details/Icy_Tower>.
- Archive package SHA-1: `21aa4fb949c5f0718a59f922df6ad644a80e6715`.
- Installer SHA-256:
  `e8a6ddc8a11d49b1e68484f725afc9204d9d15e0bf6cf90f0b14f0d1c9d24302`.
- Installed `icytower13.exe` SHA-256:
  `e139648070ec1de00c7cbb135db664dd725c1cdb6d2ecad3108b8b9f906cf4de`.

The installed readme says the game is freeware and encourages distribution in
its original form. It requires proper credit to Free Lunch Design and a link to
the project site, and prohibits inclusion in commercial compilations or other
commercial packages without author permission. Public packaging must preserve
those conditions. The extracted browser fixture remains local because it is not
the original distribution form.

## Native installer path

The 2.6 MB package is a bootstrap. It writes a 658 KB Inno Setup child beneath
`C:\windows\temp` and launches it with an `/SL4` argument tied to the original
package. `test/test-icy-tower-candidate.js` runs the unchanged bootstrap with
`--capture-launch`, then runs the captured child with that exact argument while
mounting the original installer at its guest path.

All extraction therefore happens inside Wine-Assembly. The host receives the
installed VFS only after the wizard runs; the test then verifies the exact game
hash and the distribution text in the installed readme.

This older Inno build retains the button renderer title `Next >` on its Ready
page even after painting it as **Install**. The test detects the Ready page and
delivers a physical click to that persistent button. Directly invoking the
button procedure from control-channel evaluation would lose the installer
continuation when extraction yields.

Set `PREPARE_ICY_TOWER_DEBUG_WEB=1` while running the test to copy the
emulator-installed payload to the ignored `installed/` directory and generate
its `.wine-assembly-browser.json` manifest.

## Frozen gameplay route

```bash
node test/test-icy-tower-candidate.js
```

Both phases use the stdin control channel. Gameplay remains frozen between
short explicit step bursts, so waiting for the driver consumes no emulator CPU.
After the 640x480 title menu renders, the test presses the documented Space key
to select **Start Game**, captures the first tower frame, holds Right, and
captures Harold at his new position. Both frames must contain the indexed game
art and differ by more than 1,000 pixels.

Screenshots are written to `build/icy-tower-candidate/`: the installer finish
page, title menu, and two gameplay frames.
