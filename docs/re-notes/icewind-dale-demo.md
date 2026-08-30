# Icewind Dale demo — local candidate

The official English demo is pinned in `test/candidate-corpus/manifest.json`
from Archive item `icewind_dale_eng_demo`. Its README expressly prohibits
copying/electronic distribution, so the extracted fixture stays ignored and
must not be deployed or rehosted.

Fetch and test (the fetch recipe requires `unshield`):

```sh
node tools/fetch-candidate-corpus.js --id=icewind-dale-demo
node test/test-icewind-dale-demo.js
```

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
