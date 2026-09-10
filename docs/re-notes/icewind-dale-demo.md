# Icewind Dale demo — local candidate

The official English demo is pinned in `test/candidate-corpus/manifest.json`
from Archive item `icewind_dale_eng_demo`. Its README expressly prohibits
copying/electronic distribution, so the extracted fixture stays ignored and
must not be deployed or rehosted.

Legacy fetch and test (the fetch recipe requires `unshield`; this is not
evidence that the original installer works):

```sh
node tools/fetch-candidate-corpus.js --id=icewind-dale-demo
node test/test-icewind-dale-demo.js
```

## Original installer investigation

The original `Setup.exe` successfully emits its InstallShield 5.5 engine
through guest execution. Replay that emitted engine, not a host-extracted
cabinet. The following frozen CLI route uses an isolated build and leaves
the legacy gameplay fixture untouched:

```sh
node test/run.js \
  --exe=test/binaries/candidates/icewind-dale-demo/icewind_dale_eng_demo/Setup.exe \
  '--vfs-include=**/*' --no-build --no-threads --quiet-api --quiet-blocks \
  --no-close --screen=800x600 --batch-size=100000 --tick-ms-per-batch=100 \
  --max-seconds=180 --control-stdin --frozen \
  --capture-launch=/private/tmp/iwd-original-bootstrap
```

Step 100 batches, then quit cleanly and wait for the capture to finish.
`launch.json` identifies the guest-produced
`windows/temp/_istmp1.dir/_ins5576._mp` (557,056 bytes), with its original
`zdatai51.dll` and `_wutl951.dll`. The 96-file capture includes the original
cabinet and CD2 source tree; those source files are copied, not decompressed
by the host.

```sh
node test/run.js \
  --exe=/private/tmp/iwd-original-bootstrap/windows/temp/_istmp1.dir/_ins5576._mp \
  '--exe-guest-path=C:\WINDOWS\TEMP\_ISTMP1.DIR\_INS5576._MP' \
  --vfs-tree=/private/tmp/iwd-original-bootstrap '--cwd=C:\' \
  --dll-seed=/private/tmp/iwd-original-bootstrap/windows/temp/_istmp1.dir/zdatai51.dll,/private/tmp/iwd-original-bootstrap/windows/temp/_istmp1.dir/_wutl951.dll \
  --no-build --no-threads --quiet-api --quiet-blocks --no-close \
  --screen=800x600 --batch-size=100000 --tick-ms-per-batch=100 \
  --max-seconds=300 --control-stdin --frozen \
  --save-vfs=/private/tmp/iwd-original-installed-vfs
```

At batch 300 the Welcome screen is visible. Send
`{"cmd":"dlg-input-click:1"}` and step 50 for the License screen; its Yes
button is ID 6. Accept that button and step 50 for Recommended setup.
Thereafter click ID 1 and step 50 at each of Setup Type, CPU Speed,
Destination, and Program Folder. The unchanged defaults install to
`C:\Program Files\Black Isle\Icewind Dale Demo`. At batch 750 the native
install progress window is visible; at batch 1750 it shows 11%, with
`iddemo.exe` (6,283,264 bytes), `dialog.tlk` (2,942,485 bytes), override
resources, characters, and the first area archive actually written by the
guest. At batch 3750 the progress is 18%; at batch 5750 it is 24%, with
284 files totaling 117,868,153 bytes under the destination (including the
in-progress archive). These screens and file sizes were inspected on the isolated
`6cada250` runtime. This is partial installation evidence, not yet a
completed-install or fresh-installed gameplay pass.

The 300-second internal execution guard stopped normally at batch 7177
inside the guest cabinet DLL (`EIP=0x007b4d3f`), and the VFS export completed
with process exit 0. This exit is a test deadline, not Setup Complete.
The destination contains 284 files totaling 142,198,393 bytes. Read-only
comparison against the legacy reference found 280 byte-identical files;
`Data/chranim.bif` is still partial (52,695,040 of 69,527,564 bytes), and
the original 316-byte `icewind.ini` differs from the legacy patched INI.
The other two files are installer-created `uninst.isu` and `readme.txt`.
The installed EXE SHA-256 is
`b94816d10029cb99c0315f175330c917be2fff298394e853e2764973d8d13af4`.

### Longer execution and interrupted-install replay

A fresh replay with `--max-seconds=1800` reached inspected progress screens
at batches 8750 (34%), 9750 (37%), 10750 (40%), 12750 (47%), 14750 (53%),
16750 (59%), 18750 (65%), and 20750 (79%). The internal deadline stopped
at batch 21190, `EIP=0x007b4edd`, still inside cabinet decompression.
It exited cleanly and exported `/private/tmp/iwd-original-complete-vfs`;
despite that directory name, this is **not a complete installation**.
Its destination has 302 files totaling 407,579,613 bytes, with 298
byte-identical to the legacy reference. The incomplete file is now
`Data/sndspell.bif` (21,606,400 of 22,416,309 bytes). The other differences
remain the unpatched INI and installer-created README/uninstall log.
No payload bytes were supplied by a host decompressor.

Directly replaying the engine from that export exits with guest code 4
before its wizard: `_ins0432.ini` and `_isenv31.ini` have been consumed.
Running the original `Setup.exe` again with the exported VFS succeeds and
emits a fresh engine under `_ISTMP2.DIR`, preserving the installed files.
This capture is `/private/tmp/iwd-rebootstrap` (426 files). Its engine
reaches the same wizard, but selecting Program Folder produces
`unInstaller setup failed to initialize. You may not be able to uninstall
this product.` Dismiss the native message box with `dlg-cmd:1`; unlike the
guest wizard buttons, `dlg-input-click:1` alone did not dismiss it.
This interrupted-install route is not a clean-install acceptance.

It also does **not** resume decompression: after 1000 additional copy steps
the wizard shows 11%, and the previously complete `Data/ar1000.bif` has
been replaced with an 8,632,320-byte partial file. The original partial
`sndspell.bif` is untouched. This probe was quit explicitly; its separate
`/private/tmp/iwd-original-reinstall-vfs` export must not replace the earlier
output. A subsequent completion attempt needs one uninterrupted run with
sufficient internal execution allowance, not repeated partial-VFS replay.

Next: require the actual completion screen and verify the complete output before
changing the fetch recipe or registry. Then test gameplay using the original
installed INI/KEY and CD2 layout. Do not reuse this partial directory as an
installed fixture or assume the legacy KEY/CBF modifications remain necessary.

## Legacy fixture preparation

The package is an outer ZIP containing an InstallShield cabinet and CD-resident
data. The fetch recipe extracts the `Recommended compressed` group and merges
the official `CD2/Data` tree into the local installed `Data` directory. Without
that merge the real executable renders its “insert CD in D:\” screen forever.

The fetch recipe rewrites the extracted portable `HD0:=.\` alias to the
installed layout used by the emulator (`HD0:=C:\`, `CD1/CD2:=D:\`). This
Infinity build's dot-prefix branch strips two characters from the original
`hd0:` resource path, producing malformed `C:\0:\...` paths; the absolute
installed aliases let it open `Dialog.tlk` and its BIF resources normally.

## Local-session startup

The original `IDirectPlayLobby2_CreateCompoundAddress` shim returned `S_OK`
and an output size of zero for every call. Infinity Engine uses the documented
two-call sizing pattern in its local-session initializer: first it supplies a
null address buffer and requires `DPERR_BUFFERTOOSMALL` (`0x8877001E`) plus the
required byte count, then it allocates that buffer and calls again. Returning
success from the size probe made the initializer abort, leaving Create Game to
show “Cannot connect to the game session.”

The handler now sizes and packs each `DPCOMPOUNDADDRESSELEMENT` as a GUID,
data length, and payload. `test/test-directplay-lobby-address.js` pins the null,
undersized, and successful-buffer cases independently of the game.

The localhost dropdown must also mount every archive marked as installed
(`location=1`) in `CHITIN.KEY`. The old menu-only 19-file manifest omitted
`BCSgen.bif` and later installed archives; once DirectPlay succeeded, the
installed-resource pass stopped at `ChDimm.cpp:817`, reported the CD as removed,
and terminated. The dropdown now mounts all 34 location-1 archives present in
the Recommended install.

## CD2 and first-area gameplay

The official package's `CD2/Data` directory supplies 24 compressed area/creature
BIFs, two movie BIFs, and `IWDCD.2`. Merely mounting those files under `D:` was
not enough: manifest mounting registered each file and immediate parent but did
not register the `d:\` drive root. Consequently `SetCurrentDirectory("D:\")`
and the game's `FindFirstFile("D:\\*.*")` disc scan failed even though
`D:\data\IWDCD.2` itself resolved. The VFS mount helper now registers the drive
root and every ancestor, and Win32/DOS `*.*` enumeration also matches
extensionless directory names such as `cd2`.

The CBFs are host-inflated once by local fixture preparation into normal BIFF
files. Its matching `CHITIN-full.KEY` changes the 24 expanded BIFs and two
direct movie BIFs from CD2 (`location=9`) to HD (`location=1`). The
retail-derived KEY also advertises 2,464 resources whose backing BIFs are not
in the official demo at all, including `SNDVO.bif`; leaving those entries
active made the loader run its six-pass, 200 ms CD poll forever for an archive
no disc in this package contains. The prepared KEY retains the 12,682
resources backed by the 60 installed/demo archives and removes only those
dangling entries.

NPC and narration audio that retail stores in `SNDVO.bif` is intentionally
loose in the demo. The dropdown mounts all 188 supplied `Override/*.wav`
replacements. Non-audio override resources are not bulk-mounted at startup:
some intentionally replace UI/game resources and activating the whole
directory before the demo's normal phase switch trips
`ChUIControls.cpp:6668`.

## Character-generation sound sets

The executable's `JigSawedME` window title is the official demo build's
internal name; it is unrelated to the Win16 JigSawed app elsewhere in the
corpus.

After the Appearance dialog, the demo clears panel 45 and dynamically creates
one control per directory returned by `FindFirstFile(".\\sounds\\*")`. With
only `Sounds/sndlist.txt` mounted, the directory scan produced no sound set,
the linked-list loop created zero controls, and the immediate lookup of control
0 returned null. The caller at `0x0069CDD1` then entered the assertion at
`0x00534341` (`ChUIControls.cpp:5945`).

The Recommended install contains 16 official sound-set directories with 40
WAV files each (15 MiB total). The localhost manifest now mounts all 640 files,
which creates those directories in the VFS and keeps Play usable after a set
is selected. The exact acceptance completes Gender, Portrait, Race, Class,
Alignment, Abilities, Skills, and Appearance, then requires the populated
16-set Sound panel after the formerly failing Appearance Done click.

The local acceptance skips the intro, requires the detailed menu frame, clicks
Create Game, requires the large transition to Party Formation, opens a
party slot, and drives character creation through the Sound panel. An error
modal or a generic menu-frame change can no longer satisfy the test. The CLI
capture must retain the menu labels and the Prologue title/buttons as real
light GUI-font glyphs; detailed stone artwork without dynamic text is a
failure, even if the same run later reaches gameplay.

`test/test-icewind-dale-menu-web.js` applies the same label-band gate to a
fresh, no-cache Chrome page and also requires the browser VFS to contain the
2,942,485-byte `Dialog.tlk` plus `Data/GUIfont.bif`. It keeps sampling the
actual 640x480 DirectDraw layer for another 30 seconds after the first complete
menu, so a transient first-good frame cannot satisfy the browser regression.
The repeated blank-label reports were not explained by a stale tab: a later
fresh-page report disproved that earlier diagnosis. Repeated exact Chrome runs
kept 738 label glyph pixels throughout the sustained sampling window; no
runtime change is claimed without a reproducible failing transition.

It then names the character `CODEX`, accepts the party, waits through the real
first-area resource load, and requires the native `PROLOGUE` chapter screen.
The chapter narration body is currently blank, but `REPLAY` and `DONE` render.
Pressing Escape hides this panel without completing it and exposes the tavern
under Infinity's `Paused for chapter text` lock—the exact state previously
misclassified as playable because the acceptance treated red status glyphs as
success. The corrected route activates `DONE`, captures the unpaused tavern,
clicks a distant floor point, and requires the created character's pixels to
move. Acceptance then requires the native multiplayer-session state at
`mpsave/default/icewind.gam` and verifies that its party bytes contain
`codex`; the old `NO DISC IN DRIVE D:` screen and a loading image can no
longer count as gameplay, and neither can a static paused HUD. The demo's Q
path did not produce a complete numbered save slot under emulation, so the
test does not mislabel that unavailable path as the persistence contract.

The app opts only authored state into browser persistence (`Characters`,
`Save`, and `MPSave`). A fresh-Chrome regression writes the native default
multiplayer session through the browser VFS, reloads the page, attaches a new
VFS under the same `icewind_dale_demo` app id, and verifies one restored
app-scoped entry whose bytes still contain `codex`. This covers the actual
multiplayer session path written during character acceptance rather than
treating temporary files as saved character state.

An exact browser run with cross-origin isolation and Threads enabled reached
Party Formation with four secondary guest workers. The manifest-driven CLI
acceptance reaches the first-area HUD and native default session save with the
same dropdown asset list.
