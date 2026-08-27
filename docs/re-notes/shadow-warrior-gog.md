# Shadow Warrior Classic Complete (GOG build 2.0.0.7)

## Provenance and distribution status

The local fixture came from the Internet Archive `gog_collection` item and is
pinned in `test/candidate-corpus/manifest.json` as SHA-1
`92f1c925d235c3176ab4c21b6f1f0461b1b602c8`. The corresponding GOG product was
listed at USD 0.00 when inventoried on 2026-08-25. This is a zero-price
proprietary game, not shareware and not freely redistributable. The installer
and extracted payload therefore remain gitignored local research fixtures.

The PE32 installer is 241,578,288 bytes. GOG packages the original DOS game,
its two expansions, music, and a Windows DOSBox 0.74 runtime. The locally
extracted `app` tree is 400,345,582 bytes; notable files are the 136,829,952-byte
`GAME.GOG`, 2,323,389-byte `Sw.exe`, and 3,727,360-byte
`DOSBOX/DOSBox.exe`.

## Installer investigation

The outer installer was run directly in Wine-Assembly, without host Wine. It
unpacked a 1,233,216-byte Inno Setup runner at
`C:\windows\temp\is-n3ssn.tmp\setup_shadow_warrior_complete_2.0.0.7.tmp` and
crossed the `CreateProcessW` boundary with:

```text
/SL5="$10001,241033519,205824,C:\setup_shadow_warrior_complete_2.0.0.7.exe"
```

Renaming that inner executable and launching it directly avoids its temporary
path collision and opens `Setup - Shadow Warrior Complete`, but a bounded
60-second silent run produced only Inno support files, not the game payload.
The local fixture was therefore unpacked with `innoextract`; no host Wine was
used for installation or execution.

## Confirmed launch path

The original GOG Windows DOSBox hosts the DOS `SW.EXE` payload inside
Wine-Assembly:

```sh
node test/run.js \
  --exe=test/binaries/candidates/gog-free-shadow-warrior-classic/installed/app/DOSBOX/DOSBox.exe \
  '--args=-conf "c:\dosbox_swarrior.conf" -conf "c:\dosbox-wa.conf" -noconsole' \
  '--vfs-include=*' '--vfs-include=../**/*' \
  '--vfs-mount=test/binaries/candidates/gog-free-shadow-warrior-classic/installed/app/dosbox_swarrior.conf=c:\dosbox_swarrior.conf' \
  '--vfs-mount=test/configs/shadow-warrior-wine-assembly.conf=c:\dosbox-wa.conf' \
  --no-build --screen=800x600 --max-batches=10000 --max-seconds=360 \
  --batch-size=5000000 --real-ticks --repaint-every=20 \
  --stuck-after=1000000 --quiet-api --quiet-blocks --no-close \
  --png=/private/tmp/shadow-warrior.png
```

`node test/test-shadow-warrior-dosbox.js` automates this long local acceptance.
The dynamic core retains `SW` as the active program and visibly renders the
Shadow Warrior 1.2 startup banner plus keyboard/input initialization. A measured
frame had 17,948 green title pixels, 4,943 white copy pixels, 233,109 black
pixels, and five guest-frame colors.

This is a startup acceptance, not yet a gameplay claim. The run has reached
`CONTROL_Startup: Mouse Present` without a fault, but has not yet reached the
game's VGA intro or interactive menu under nested execution.

## Apparent dynamic-core hang

The first run used Wine-Assembly's synthetic `--tick-ms-per-batch=200` clock and
appeared stuck at DOSBox's SDL `_DX5_CheckInput`, immediately after
`GetMessageA`. API tracing showed a repeating private message (`0x7FF0`, timer
ID 1) installed by SDL's high-frequency multimedia timer. Each fast API call
advanced the synthetic clock by at least one millisecond, so consuming one timer
message made the next timer immediately due. This was a host-clock feedback
loop, not divergent execution in DOSBox's dynamic recompiler.

`--real-ticks` breaks the feedback loop and lets the unmodified dynamic core
enter `SW.EXE`. In an equal 120-second comparison, `core=simple` was still at
the DOS/4GW banner while `core=dynamic` had rendered the game-specific startup
screen and initialized input. Raising the fixed cycle target from 50,000 to
500,000 only reduced host throughput, and substituting Daggerfall's newer GOG
DOSBox 0.74-2.1 did not advance farther. The title's original DOSBox 0.74 with
`core=dynamic`, 50,000 fixed cycles, and real ticks remains the canonical path.
