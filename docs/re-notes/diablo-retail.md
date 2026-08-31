# Diablo retail (CD install, v1.00)

Companion to [diablo-shareware.md](diablo-shareware.md) — same engine, but the
retail disc adds the install flow and the CD check. Everything here was
established against a 580MB retail ISO (volume label literally `1`, serial
`CA70A7DA`, primary names only, no Joliet).

## Getting from the ISO to a running game (headless)

```bash
# 1. The installer IS AUTORUN.EXE (SETUP.EXE is a 17KB stub). Run it off the
#    mounted disc with a writable overlay; click "Install & Play Diablo"
#    (row at ~120,62), then OK in the "choose install directory" dialog
#    (button at 402,397). ~17 files land in the overlay.
node test/run.js --iso=DIABLO.ISO --iso-exe=AUTORUN.EXE --overlay-dir=DIR \
  --quiet-api --batch-size=200000 --max-batches=30000 \
  --input=3500:mousedown:120:62,3520:mouseup:120:62,6000:mousedown:402:397,6020:mouseup:402:397

# 2. The overlay now holds c:\diablo\{diablo.exe,storm.dll,diabloui.dll,
#    smackw32.dll,battle.snp,standard.snp,diablo.ini,...} plus diabunin.exe /
#    bnetunin.exe in c:\windows. Extract the blobs (index.json maps
#    path -> blob) and launch with the disc still mounted:
node test/run.js --exe=DIR/diablo.exe \
  --dlls=DIR/storm.dll,DIR/diabloui.dll,DIR/smackw32.dll \
  --vfs-include='*.snp,*.ini' --iso=DIABLO.ISO \
  --quiet-api --batch-size=200000
```

`--dlls=` is required: only `storm.dll` is in `APP_LOCAL_DLLS`
(lib/dll-registry.js), so a bare `--exe` resolves the `diabloui.dll` imports to
emulator thunks and the run dies at `UNIMPLEMENTED API: UiAppActivate`.

## The CD check (storm.dll, fn entry 0x1500d28a)

The insert-CD dialog is decided entirely between `0x1500d446` and
`0x1500d530`, by XOR-folding API results — no file on the disc is ever opened
by the check itself:

1. `GetFileAttributesA("<letter>:\diabdat.mpq")` per drive from
   `GetLogicalDriveStringsA` — must exist (case-insensitive; the disc stores
   `DIABDAT.MPQ`).
2. `GetDriveTypeA` → `esi` (wants 5, DRIVE_CDROM).
3. `GetVolumeInformationA(root, 0,0,0,0, &fsFlags, fsName, 0x104)` — label and
   serial are NOT requested.
4. `GetDiskFreeSpaceA(root, &spc, &bps, &free, &total)`.
5. Fold: `x = (fsFlags&4) ^ bps ^ free ^ fsName[0..3] ^ driveType`, then
   `ax = (x>>16) ^ (x&0xffff)`; accepted values `0x1f00` and `0x805`.
   - `0x1f00` = `2048 ^ "CDFS" ^ 5` (a real Win98 CDFS answer).
   - `0x805`  = `2048 ^ 5` with an empty fs name.
   `spc` and `total` are not folded, so their values are free.

Fixed in 5a7bd4f2 by answering like Win98 CDFS for any CD-mounted root:
`GetDiskFreeSpace` = 1 sector/cluster, 2048 bytes/sector, 0 free, PVD
volumeSpaceSize total (new `fs_volume_size` host import);
`GetVolumeInformation` fs name = `"CDFS"`. Regression tests in
test/test-iso-mount.js.

## Disc layout notes

- `DIABDAT.MPQ` (517MB, LBA 2961 — contiguous, so `dd bs=2048 skip=2961` carves
  it) holds game data only: `Diablo.exe`/`storm.dll`/`diabloui.dll` are NOT in
  its hash table (verified — data names like `ui_art\title.pcx`,
  `ctrlpan\panel8.cel` all resolve). The program files come out of the
  installer inside AUTORUN.EXE (4.4MB).
- `DRTL104.EXE` on the disc root is the 1.04 patch (552KB), `DEMO\BLIZDEMO.EXE`
  a 20MB Smacker demo player, `DIRECTX5\` the DX5 redist.

## Known behavior headless

- Title screen ("Diablo v1.00" bottom-left) is reached in ~1800 batches at
  `--batch-size=200000`, but its palette fade paces on `timeGetTime` and the
  frame stays byte-identical for thousands of batches — the standard
  batch-clock stall, not a renderer bug (see CLAUDE.md on Diablo's intro).
- Escape at the title/menu exits the app cleanly (`[Exit] code=0`) — don't use
  Esc to "skip intros" in scripted runs.
