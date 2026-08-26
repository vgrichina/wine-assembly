# The Elder Scrolls II: Daggerfall (GOG build 28043)

## Provenance and distribution status

The local fixture came from the Internet Archive `gog_collection` item and is
pinned in `test/candidate-corpus/manifest.json` as SHA-1
`05276866d94746987a56617b708fa6eb4653359b`. The corresponding GOG product was
listed at USD 0.00 when inventoried on 2026-08-25. That makes this a
zero-price proprietary game, not shareware and not freely redistributable.
The package and its extracted 538 MB payload therefore remain gitignored local
research fixtures; only configuration, provenance, and tests belong in git.

The downloaded installer is a Windows PE program. The installed game itself is
DOS software: `FALL.EXE` contains the CauseWay 3.32 DOS extender. GOG bundles a
Windows build of DOSBox 0.74-2.1 at `installed/DOSBOX/DOSBox.exe`, which is the
executable Wine-Assembly hosts for this acceptance path.

## Confirmed launch path

Apply the GOG base configuration followed by the two repository overrides:

```sh
node test/run.js \
  --exe=test/binaries/candidates/gog-free-elder-scrolls-daggerfall/installed/DOSBOX/DOSBox.exe \
  '--args=-conf "c:\dosbox_daggerfall.conf" -conf "c:\dosbox-wa.conf" -conf "c:\dosbox-launch.conf" -noconsole' \
  '--vfs-include=*' '--vfs-include=../**/*' \
  '--vfs-mount=test/binaries/candidates/gog-free-elder-scrolls-daggerfall/installed/__support/app/dosbox_daggerfall.conf=c:\dosbox_daggerfall.conf' \
  '--vfs-mount=test/configs/daggerfall-wine-assembly.conf=c:\dosbox-wa.conf' \
  '--vfs-mount=test/configs/daggerfall-launch.conf=c:\dosbox-launch.conf' \
  --no-build --screen=800x600 --max-batches=2100 --max-seconds=240 \
  --batch-size=2000000 --tick-ms-per-batch=200 --repaint-every=20 \
  --stuck-after=1000000 --quiet-api --quiet-blocks --no-close \
  --png=/private/tmp/daggerfall.png
```

`node test/test-daggerfall-dosbox.js` automates the same long local acceptance.
On the 2026-08-26 verification run, `FALL` remained the active DOS program and
the Bethesda Softworks credit was visible by batch 2000 (about 180 seconds on a
heavily loaded development Mac).

## Failure localization

With GOG's `core=auto`, DOSBox selects its dynamic x86 recompiler. CauseWay then
exits immediately with:

```text
CauseWay error 05 : Not enough memory for CauseWay.
```

This is not a real memory shortage. DOS `MEM` reports 632 KB conventional and
63,296 KB extended memory. A real-mode probe following CauseWay's calls sees XMS
3.01, a 63,424 KB largest block, and successful allocate, lock, and free calls.
Disabling EMS does not change the failure. The important boundary is the nested
JIT: DOSBox's dynamic core emits x86 code at runtime, and Wine-Assembly must then
interpret that generated code. `core=simple` stays in DOSBox's interpreter,
keeps CauseWay alive, enters the 320x200 graphics mode, and renders the intro.

Before the core switch could be tested reliably, commit `37d8cf43` moved
DirectDraw surface pixels out of Wine-Assembly's decoded-page index arena. That
fixed the independent corruption where DOSBox's third 640x480 surface overlapped
`PAGE_INDEX_ARENA` and invalidated live translated blocks.
