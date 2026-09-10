# Darkstone demo 1.0

## Package and installation

The local package comes from the Windows 98 A-D archive recorded in
`sources.md`. Its original `Setup.exe` is an InstallShield bootstrap, not the
game executable. `tools/install-darkstone-demo.js` runs that bootstrap inside
Wine-Assembly, captures the `_INS5576._MP` child it emits, and then drives the
guest installer through Welcome, destination selection, program-folder
selection, file copy, and Setup Complete.

The installer must see the package recursively: `dvoices1.mtf` is under the
source `data/` directory. Mounting only top-level files correctly produces
InstallShield move-data error `-113`; the installer tool uses `**/*` and checks
the complete payload instead. The host copies files only after the guest
installer has written them.

Pinned SHA-256 values:

- original `Setup.exe`: `a6d2f8b9173fd43f03aabff0b8cc3fadbd0b15224bcbe5f562a32158a297b502`
- emitted `_INS5576._MP`: `c9d2bee521bc3d8037b164c9468b145646fc556a6969acf83f5556e4b295fc79`
- installed `darkstonedemo.exe`: `b43db5e1b835eb1e93688a1f3f1d9c814517be6fc8110c7fb6e024d467ee721b`
- installed `ddata.mtf`: `0e9f56d01af4738e09dcdd9a7de21ff9e683468259465553e1edb0ebe3a66850`
- installed `dmusic.mtf`: `eec342ef67fb2440cd705eafaf4411eccd67d3aa888db7097aa0f551d39d99e0`
- installed `dvoices1.mtf`: `bd01d2b6dda05b792c22371ab5cba1e36fb316fe0d81401a49fe9169beecee9e`

The resulting `installed/` tree contains 14 files and 33,471,003 bytes before
manifest generation. The app and generated manifest now use only that tree.
Run the authentic installer with:

```bash
node tools/install-darkstone-demo.js
```

## Distribution status

The installed readme calls the package `DARKSTONE Demo 1.0`, describes its
reduced music and voice assets, and lists Windows 95 or 98 as supported. It
does not contain an explicit grant to redistribute the package. The original
installer and its generated playable tree therefore remain local and
gitignored. `sources.md` links the preserved original distribution so it can be
obtained independently; Wine-Assembly does not publish these game files.

## Gameplay route

`test/test-darkstone-gameplay.js` launches the registered app through one
headless CLI process with cooperative scheduling, frozen stdio control, and the
CLI's own `--max-seconds` guard. It skips the logo, selects New Game and One
Player, creates a warrior named `CODEX`, and moves the new champion into the
first party slot. The slot assertion is scoped to the portrait region so a
card merely following the cursor cannot pass.

Demo 1.0 enters Town directly after party confirmation; unlike the retail
manual's route, it does not display a difficulty menu. The test waits through
the forest loading animation. Its live-town check requires the blue mana HUD
that is absent from the loader, then holds the right-arrow key and requires a
substantial pixel change from camera rotation. This is a functional acceptance
test, not a performance benchmark. Screenshots default to the system temporary
directory.

Run explicitly with:

```bash
node test/test-darkstone-gameplay.js
```
