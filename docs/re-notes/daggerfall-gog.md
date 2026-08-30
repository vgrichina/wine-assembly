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
On the 2026-08-26 dynamic-core verification run, `FALL` remained the active DOS
program and the Bethesda Softworks credit was visible by batch 2000 (9,008
credit pixels across 9 guest-frame colors).

## Dynamic-core failure and fix

GOG's `core=auto` selects DOSBox's dynamic x86 recompiler. Before the flag fix,
CauseWay exited immediately with:

```text
CauseWay error 05 : Not enough memory for CauseWay.
```

This was not a real memory shortage. DOS `MEM` reports 632 KB conventional and
63,296 KB extended memory. A real-mode probe following CauseWay's calls sees XMS
3.01, a 63,424 KB largest block, and successful allocate, lock, and free calls.
Disabling EMS does not change the result.

The Qbix DOSBox 0.74-2 heavy-debug build made the nested-JIT divergence
reproducible without host Wine. `BP`, `LOGL`, and `MEMDUMPBIN` synchronized the
simple and dynamic cores at CauseWay's protected-mode allocator entry. Both
cores had identical registers and resident memory, and the page-count dword at
`DS:0x0AA2` was `0xFFFFFFFF`.

The generated x86 block read that value correctly into `EDX`, then executed:

```asm
cmp edx, 0
stc
pushfd
jz allocation_failure
```

Wine-Assembly's old `STC` handler replaced the complete lazy-flag state with a
synthetic carry-producing state. That incorrectly set ZF, so the later `JZ`
took the failure path even though `EDX` was nonzero. `CLC` and `CMC` had the same
architectural bug. They now materialize the existing EFLAGS, alter only CF, and
restore all other flags. With that fix, the unmodified dynamic core enters
CauseWay's allocator scan at `00C3:0EDC`; the repository acceptance therefore
uses `core=dynamic` rather than the former `core=simple` workaround.

Before the core switch could be tested reliably, commit `37d8cf43` moved
DirectDraw surface pixels out of Wine-Assembly's decoded-page index arena. That
fixed the independent corruption where DOSBox's third 640x480 surface overlapped
`PAGE_INDEX_ARENA` and invalidated live translated blocks.

## Gameplay-capture handoff (2026-08-29)

The dynamic core now continues past the Bethesda credit into Daggerfall's
original character creator. These inputs must be delivered as physical
keydown/up or held mouse events; `WM_CHAR` injection is ignored. The bonus
allocation UI also needs long settling gaps. With 300 headless batches between
point clicks, the verified checkpoints were:

- attributes: STR increased to 58 and the bonus pool became empty;
- skills: Mysticism 34, Illusion 24, and Medical 20, with all three category
  counters at zero;
- reflexes: Average selected, followed by the final character review.

The first end-to-end capture used the wrong final-review coordinate:
`(60,204)` instead of the visible OK button at `(284,204)`. Its later Escape
events did not advance the page, and all five candidate gameplay PNGs were
byte-identical review frames. The corrected deterministic sequence is retained
in `tools/run-daggerfall-gameplay.js`; its partial handoff run reached attribute
allocation batch 12,770 before being stopped to wrap and commit this work. Run
the tool with `DAGGERFALL_SCREENSHOT_DIR` set to a persistent output directory,
then visually inspect its five `gameplay-*.png` frames. The local numbered frame
`/private/tmp/free-gog-screenshots.EC8yad/6-elder-scrolls-daggerfall.png`
therefore remains unaccepted until it is replaced by a visually verified
first-person dungeon frame. Do not substitute DOSBox-X or host Wine: this
reproduction deliberately exercises GOG's bundled Windows `DOSBox.exe`
directly inside Wine-Assembly.
