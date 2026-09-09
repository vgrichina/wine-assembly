# Dungeon Keeper demo

## Package and installation

The local Windows demo comes from the Windows 98 A-D archive recorded in
`sources.md`. Its own readme tells the user to run `SETUP.BAT`; that batch file
runs `KDDATA.EXE -d` to create the playable files. The registered app now uses
only that installer output under `installed/`, not the separately unpacked
`Rozbaleny/` copy.

`tools/install-dungeon-keeper-demo.js` runs the original DOS PKSFX executable
inside ToyVM, exports the files the guest creates, validates the payload, and
generates the browser manifest. It does not use a host archive extractor.
The measured result is 166 files and 19,754,866 bytes; the manifest contains
the 165 companion files mounted beside the launch executable.

Pinned SHA-256 values:

- `KDDATA.EXE`: `f121c2f77583e35a258617308f609aefbd73ca249974e3cdbac7520c4cdda92a`
- installed `KEEPER95.EXE`: `4d3cd6a7866520f360288b08440e0f20379b4b39216a9576c388e42fcdf72c84`
- installed `MSS32.DLL`: `fe46a580452a42796461cf98a66f79c65ef8494e0977d4665ac7a81305ee9644`
- installed `LEVELS/MAP00001.DAT`: `57f068b16b43b42e268bcf03794a966debb1bf0524f6a4ce2d1f875cb60c7fa9`
- installed `SOUND/SOUND.DAT`: `13e17c1ea44edb6b9bb5894e6c314ae2bc138fe6d864bf1d91aa972b3c4d7e8e`

Run the original installer with:

```bash
node tools/install-dungeon-keeper-demo.js
```

## Distribution status

The bundled readme calls this a promotional demonstration, forbids selling or
renting it, and says copying requires Electronic Arts' prior written consent.
"Playable demo" describes what the package is; it is not a redistribution
license. The package and generated install tree therefore remain local and
gitignored. `sources.md` links the preserved original distribution so a user
can obtain it independently; Wine-Assembly does not publish the demo files.

## Gameplay route

`test/test-dungeon-keeper-gameplay.js` launches the registered app through the
headless CLI in frozen stdio-control mode. It dismisses the legal/logo screens,
waits for the main menu pixels, moves the software cursor with small relative
DirectInput deltas, and clicks Start New Game without moving the host cursor.
It then follows the portal transition into the live Eversmile dungeon and
checks the in-game tutorial panel appears while the process remains healthy.

The test uses `run.js --max-seconds` as its only process guard. It performs no
performance measurement. Screenshots are written to
`build/dungeon-keeper-gameplay/`.

Run explicitly with:

```bash
node test/test-dungeon-keeper-gameplay.js
```
