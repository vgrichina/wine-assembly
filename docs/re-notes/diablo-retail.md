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
  --vfs-include='*.snp,*.ini' --iso=DIABLO.ISO \
  --quiet-api --batch-size=200000
```

All three private DLLs (`storm.dll`, `diabloui.dll`, `smackw32.dll`) are in
`APP_LOCAL_DLLS` (lib/dll-registry.js), so a bare `--exe` resolves them from
the exe's own directory. Before `diabloui.dll`/`smackw32.dll` were listed, a
bare run resolved their imports to emulator thunks and died at
`UNIMPLEMENTED API: UiAppActivate` (`jmp [0x6ad6d0]` at 0x47a542 = diabloui
IAT slot 10).

In the **browser** the whole flow is one gesture: insert the ISO, launch
AUTORUN.EXE (its INF names it), click "Install & Play Diablo", OK the
directory dialog. The launcher then calls
`ShellExecuteA("C:\Diablo\diablo.exe")`, which chain-launches the installed
game from the caller's own VFS (`launchVfsExe` in lib/browser-shell.js +
`VirtualFS.adoptFrom`) with the disc still mounted at D:. Note AUTORUN's
installed-check is the registry value
`HKLM\SOFTWARE\Blizzard Entertainment\Archives\DiabloInstall` — persisted in
localStorage, so a later session with that key but no installed files gets
SE_ERR_FNF (2) back from ShellExecute rather than a silent success.

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

### "Data File Error" in the browser is not the fold check

The browser chain-launched game passed the XOR fold (adoptFrom carries the
drive-type/volume maps) and still raised **"Data File Error — Diablo cannot
read a required data file"**. That dialog is storm failing to *read*
`diabdat.mpq`, and the read fails on the thread, not the file: storm reads its
MPQs on a spawned reader thread, in the browser the ISO entry is
provider-backed (async File API) so every non-resident chunk read parks on the
io_wait yield (12) — and `$handle_ReadFile` used to complete that park as
ERROR_READ_FAULT on any thread but the main one, because neither scheduler
serviced a spawned thread's park. Now the WAT parks on any thread and both
ThreadManager backends fill the pending chunk and clear the yield (worker:
`_runWorkerThread` yield-12 branch; cooperative: `runSlice` starts the async
fill and re-enters on the slice after it lands). Regression:
test/test-io-wait-threads.js. The CLI never sees this — its ISO provider
reads synchronously.

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

## Driven to gameplay headlessly

The shareware recipe in diablo-shareware.md transfers to retail unchanged —
same batch numbers, same geometry (retail's "New Single Player Hero" screen
lists Warrior/Rogue/Sorcerer but the Warrior row still takes the
`dblclick:320:298`). Verified end to end: flaming main menu → Choose Class →
name entry → the burning-cathedral loading screen (~batch 44000, progress bar
moving) → **Warrior standing in Tristram at ~batch 50000** with the full
control panel, both orbs and the potion belt. One run, ~10 minutes wall:

```sh
timeout -s KILL 800 node test/run.js --exe=DIR/diablo.exe \
  --vfs-include='*.snp,*.ini' --iso=DIABLO.ISO --quiet-api \
  --tick-ms-per-batch=20 --repaint-every=200 --no-close --max-batches=53000 \
  --input='38400:click:620:20,38800:click:620:20,39200:click:620:20,39500:click:620:20,39700:click:620:20,39900:click:620:20,40500:click:320:214,41300:dblclick:320:298,42200:click:425:331,42400:keypress:97,42500:keypress:98,42900:click:350:444,50000:png:/tmp/town.png'
```

**If the menu renders near-black with only faint text, check a clean build
before blaming a commit.** The whole title/menu pipeline (art, palette,
SetEntries fade) was verified correct on clean 45857dee the same night the
shared worktree's build — carrying an in-flight DirectDraw process-state
refactor — drew it almost black in both CLI and browser. A worktree build of
plain HEAD is a two-minute check
(`node tools/concat-wat.js && node tools/build-compile-wat.js`, then the title
run with `--no-build`) and it settled in one step what a commit hunt could
not.

The exact `/Users/vg/Downloads/DIABLO.ISO` was re-run on 2026-09-05 with the
installed retail v1.00 files and the disc still mounted. The native runner
advanced through the title/menu, Warrior selection, hero naming, cathedral
loading screen, and into controllable Tristram. This proves the disc layout,
installed files, `AUTORUN.INF`, CD check, and synchronous ISO path.

The browser's asynchronous ISO-provider path was re-verified through actual
Tristram gameplay. Three path-provenance details matter after hero naming:

- an app-local DLL preload must retain `C:\Diablo\storm.dll` as the module's
  path, rather than flattening it to the compatibility alias `C:\storm.dll`;
- bare `LoadLibrary("standard.snp")` follows the process current directory;
- exact current-directory lookup must precede the compatibility basename scan,
  because this disc also contains an unrelated `D:\DEMO\SMACKW32.DLL`.

With those rules, Storm derives and enumerates `C:\Diablo\*.snp`, dynamically
loads both `battle.snp` and `standard.snp`, resolves `SnpQuery`/`SnpBind`, and
creates a non-null provider object. The exact browser run then advanced through
the cathedral load into a controllable Warrior standing in Tristram. It did not
reproduce either the former `SNetInitializeProvider` error or the old generated
blitter WebAssembly trap.
