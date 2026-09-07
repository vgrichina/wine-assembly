# Packed guest-page translation experiment

## Question

Wine Assembly's common image-relative and DIB guest addresses already use
constant-time arithmetic. Sparse `VirtualAlloc` addresses instead use a
four-entry range cache followed by a linear map-record scan. This experiment
asks whether an optional packed page lookup is a useful foundation for later
Win98 page-access auditing, without changing which accesses currently succeed.

It does **not** implement `PAGE_*` enforcement. Translation mechanism and
access policy remain separate so each can be measured independently.

## Candidate

The current opt-in `--guest-page-translation` path leaves direct and DIB
translation unchanged. Sparse mappings use one flat 4 MiB array with one
four-byte PTE for every 4 KiB page in the complete 32-bit guest address space:

```text
guest address 0xFEDCBA98
          | page index = (guest >> 10) & 0x003ffffc
          v
4 MiB PTE array --------------------> backing page | access bits
                                                + guest & 0xfff
```

Sparse commits publish PTEs before the mapping becomes visible; release clears
PTEs before backing can be reused. Enabling the option backfills existing
mappings while holding the shared virtual-map lock, then makes later
allocations publish across worker instances.

There is no runtime legacy fallback in packed mode. A zero PTE is an
authoritative miss and goes directly to the normal unmapped-access result. The
old four-entry range cache and record walk remain compiled only as the off arm
of the current A/B experiment. `VIRTUAL_MAP_TABLE` still remains necessary as
allocation, release, and `VirtualQuery` metadata; translation no longer needs
to scan it. The default remains off while application/browser acceptance is in
progress.

## Synthetic results

`tools/bench-loops.js` now supports `--mapping=sparse`, the
`guest_page_translation` A/B toggle, and a `sparse_scatter` shape that cycles
through separately mapped pages. Results below use interleaved arms; positive
numbers mean packed lookup was faster.

| Sparse working set | Packed result |
| --- | ---: |
| Contiguous 2 MiB LUT loop | +0.5% |
| Contiguous 2 MiB store stream | +0.8% minimum; noisy median +4.8% |
| 1 scattered page | -7.8% |
| 2 scattered pages | +7.4% |
| 8 scattered pages | +19.0% |
| 16 scattered pages | +22.7% to +25.1% |
| 64 scattered pages | +45.6% paired median; +46.2% minima |

The result is the expected crossover: the established cache is excellent for
one hot affine mapping; packed lookup wins as the active mapping set exceeds
that cache. These are path upper bounds, not whole-application speed claims.

After rebasing the flat-table candidate onto current main, the two endpoint
controls were repeated with seven interleaved repetitions over 4 MiB. One
scattered mapping was neutral (packed minimum -0.1%, paired median +0.2%);
64 scattered mappings remained a large win (packed minimum +47.3%, paired
median +47.2%). This corrects the older one-mapping result above and shows that
the current implementation no longer pays a measurable hot-single-map tax.

## Application census and preliminary A/B

An eight-second launch census found 1 sparse mapping in Heroes II, 4 in
Heroes III, 10 in Diablo, 51 in StarCraft Shareware, and 57 in the Diablo II
demo. Fixed four-second cooperative runs then rotated off/on order to expose
host-load drift.

| Application | Packed handler-throughput pairs | Interpretation |
| --- | ---: | --- |
| Heroes II | -7.1%, +1.2% | inconsistent; effectively no demonstrated win |
| Heroes III | +12.4%, +14.8% | consistent preliminary win |
| Diablo | +0.8%, -4.9% | inconsistent; approximately neutral/slightly negative |
| StarCraft | -15.8%, +3.6% | host drift dominates; no conclusion |
| Diablo II demo | 0.0%, -0.07% | early startup is neutral |
| Diablo II gameplay | 139.99s off / 101.43s packed | one fixed-work pair: 27.5% less wall time, or 38.0% more throughput |

Diablo II also demonstrates why map count is insufficient: it has the largest
launch census but no startup throughput change. The first gameplay attempt
stopped at `Unable to start LNG manager` in both arms because the corpus
preloaded all three mutually exclusive renderers and exhausted the emulator's
16-slot DLL table before the game dynamically loaded `d2.lng`. Keeping the
selected DirectDraw dependency graph preloaded while mounting the unused
Direct3D/GDI/Glide renderers as on-demand files restored the original gameplay
gate without changing emulator-wide capacity.

The corrected replay performed the same 1,680 one-million-block batches in
both arms and captured the Rogue Encampment at batch 1,652. The two PNGs are
byte-identical (SHA-256
`c9becc47c222ac49e9609a1a817f0f75326c0e2e0e76192f4258226644fd70ff`).
Packed translation reduced externally measured wall time from 139.99s to
101.43s. This is a strong preliminary result, but it is still one pair rather
than a distribution and must not be presented as a stable gameplay speedup.

### Broader census

A second launch census sampled newer and non-Blizzard games with
`--dump-virtual-maps`. The count is the number of live sparse map records at
the sampled point, not allocated pages or memory traffic. It is useful for
choosing experiments but does not predict the result by itself.

| Sparse records | Applications |
| ---: | --- |
| 13 | Fallout demo |
| 8 | Half-Life Uplink |
| 6 | Age of Empires II Trial |
| 5 | Microsoft Commercial Multimedia demo |
| 4 | Quake II demo, GTA2 demo |
| 3 | Civilization II MGE |
| 2 | Deus Ex demo |
| 1 | Icewind Dale, RollerCoaster Tycoon, MechWarrior 3, Total Annihilation, Caesar III, Captain Claw, Jazz Jackrabbit 2, Darkstone, Cave Story, Little Fighter 2, Icy Tower, Elasto Mania, Abe's Oddysee demo, GeneRally, Jardinains, NetHack, QBob |
| 0 | Worms 2 demo, Pocket Tanks |

Several entries were still in an early or blocked launch phase, so these are
lower-bound snapshots rather than lifetime maxima. The main result is that
release year is not a useful proxy for sparse pressure: Fallout is the best
new candidate, while several later games still have one record. Alpha Centauri
was not a registered runnable corpus app at the tested commit and therefore
was not assigned a synthetic result.

### Repeated fixed-work controls

Each row below uses at least four legacy and four packed runs in a rotated,
interleaved order. Wall and user CPU medians are reported separately; the exact
batch count and input schedule were held constant. This is CLI translator
evidence, not a claim about headful browser frame rate.

| Application and sampled path | Legacy median | Packed median | Interpretation |
| --- | ---: | ---: | --- |
| Fallout demo, 8,000-batch early load | 1.125s wall / 1.255s CPU | 1.130s / 1.255s | eight runs per mode correct the shorter sample: neutral |
| Half-Life Uplink, 1,000-batch renderer startup | 19.055s / 17.275s | 17.495s / 16.460s | noisy preliminary 8.2% wall and 4.7% CPU reduction |
| Age of Empires II, 400-batch first-run flow | 0.310s / 0.325s | 0.320s / 0.335s | too short for a speed claim; effectively neutral |
| GTA2 demo, 4,500-batch gameplay entry | 9.080s / 7.715s | 7.715s / 6.830s | variance is large; neutral-to-positive, with no demonstrated regression |
| Quake II demo, 1,200-batch GL startup | 2.205s / 2.190s | 2.200s / 2.205s | neutral within measurement noise |

Correctness pairs reached the same fixed-work boundary in both modes. The
Fallout title, Half-Life startup, AoE II first-run frame, GTA2 Wild Demo frame,
and Quake II renderer frame were byte-identical between modes. GTA2 also ended
with identical thread/CPU state and execution counters; Quake II ended with
identical execution counters. The long Fallout pair had severe run-order drift
(56.41s/36.94s then 35.05s/22.32s). Doubling the short interleaved series to
eight runs per mode removed the apparent packed win; the table reports that
larger neutral sample.

## Why the flat table replaced the first prototype

The first demand-leaf design saves roughly 3MB but needs two dependent atomic loads,
has a finite leaf arena, indexes only the lower 2GB, and retains a legacy-scan
fallback. A follow-up replaced it with one 4 MiB array: one four-byte PTE for
every 4 KiB page in the complete 32-bit guest address space.

```text
guest address 0xFEDCBA98
          | page index = (guest >> 10) & 0x003ffffc
          v
4 MiB PTE array --------------------> backing page | access bits
                                                + guest & 0xfff
```

The first implementation failed its runtime gate immediately: using
`guest >> 10` without clearing its low two bits made non-page-aligned scalar
accesses issue unaligned atomic loads. Keeping that failure in the experiment
was useful—the corrected mask above is now exercised by cross-instance scalar
reads, releases, recommits, and an explicit mapping above `0x80000000`.

The same rotated sparse microbenchmark produced:

| Scattered mappings | Two-level result | Flat-table result |
| ---: | ---: | ---: |
| 1 | -7.8% | +0.9% paired median |
| 2 | +7.4% | +10.0% |
| 8 | +19.0% | +27.8% |
| 16 | +22.7% to +25.1% | +32.1% |
| 64 | +45.6% | +46.8% |

Those percentages compare each packed implementation with its own legacy arm.
Directly alternating the two packed artifacts made them effectively tied: the
flat table was 0.5% faster at one mapping and 1.4% faster at 64 mappings, below
this session's trustworthy threshold. The important result is therefore not a
speed claim between packed layouts. It is that the flat table retains the
fragmented-map win, removes the one-map loss, covers all guest addresses, and
needs neither leaf management nor a translation fallback.

Flat-table application controls remained neutral. Quake II's 1,200-batch GL
startup measured 2.580s median wall and 2.560s CPU in both arms. Fallout's
expanded 8,000-batch series is the neutral row above; a separate 32,000-batch
title pair took 13.51s/13.65s and produced byte-identical frames with identical
execution counters. Half-Life's eight-run-per-mode repeat measured 10.085s
legacy versus 10.110s packed wall time (10.505s/10.600s CPU), correcting its
earlier noisy apparent win to neutral. Quake II's flat-table off/on frames were
also byte-identical.

## Offline path census

`tools/build-page-translation-stats.js` builds a separately named,
instrumented WASM artifact. It atomically counts translation paths across the
main and guest-thread instances without adding a branch to the production
module. `test/run.js --guest-page-stats` reports the counters and rejects a
canonical artifact, so the census cannot accidentally be mistaken for an
ordinary benchmark build.

The counters reset immediately before guest execution, excluding PE/DLL load
and packed-table backfill. These short runs are path censuses, not throughput
benchmarks—the atomic increments intentionally perturb timing.

| Application | Direct | DIB | Packed hit/miss | Legacy work in packed mode |
| --- | ---: | ---: | ---: | ---: |
| Heroes III, 3s | 60,785,583 | 390,177 | 542,328 / 1 | 0 |
| StarCraft Shareware, 5s | 80,309,409 | 3,702,407 | 3,189,735 / 0 | 0 |
| Diablo II demo, 5s | 142,114,125 | 14 | 65,416,844 / 0 | 0 |
| Alpha Centauri v4, 5s | 80,363,555 | 1,516,778 | 746,791 / 0 | 0 |

Diablo II's matching legacy run made 65,520,052 sparse-cache hits and 15,465
record-scan hits. Those scans examined 617,374 records, an average depth of
39.92. The first packed census still showed roughly 62 million legacy
translations because the option was applied only to the main WASM instance;
the declarative inherited-global table discarded it for guest-thread
instances. Adding `set_guest_page_translation`/`get_guest_page_translation` to
that shared table makes both cooperative and real Worker backends inherit the
option. Focused Worker tests and all three repeated packed censuses now show
zero legacy translation activity.

Alpha used the complete 395-file disc program tree with Firaxis's official v4
replacement payload layered over it, matching the diagnostic browser setup
that reaches gameplay. Its matching legacy census made 746,750 sparse-cache
hits and 41 record-scan hits; the scans examined 486 records (11.85 average
depth). This establishes its translation shape, not production installer
acceptance—the separate exact-disc path still has to run the original updater
inside the emulator.

The census also covers `$g2w_affine_span`, the bulk-operation helper that had
still used the legacy range cache/table even when scalar packed translation
was enabled. Packed mode now proves a span by checking every crossed PTE maps
to the expected contiguous backing page; it never enters the legacy span
cache or record scan. None of the short launch windows above requested a
sparse affine fast path. A focused backward `REP MOVSD` regression forces a
span across adjacent guest pages with non-contiguous backing and proves both
translators reject the unsafe fast path and complete through elementwise
translation instead. Separate tests cover contiguous, unmapped, zero-length,
and wrapping packed spans.

The browser exposes the same experiment as `?guest-page-translation`, applied
before the guest's first slice. A StarCraft browser smoke run stayed live
(four of five screen probes changed) and reported the option enabled in both
the main and spawned cooperative WASM instances.

StarCraft was then repeated under the project's acceptable host-load threshold
in rotated legacy/packed order, with a four-second warmup and five-second
sample. Legacy guest frame rates were 14.61 and 14.64 fps; packed rates were
14.99 and 14.59 fps. Their medians (14.63 versus 14.79 fps, +1.1%) are within
browser-run noise, so this is a neutral result rather than a speed claim. All
four runs stayed live at the same guest EIP and showed no frame-pacing
regression. The browser's instantaneous `stepsPerSec` snapshots varied by
multiple billions between otherwise equivalent runs and are therefore not
used as evidence.

## Verdict

Keep the candidate isolated until the remaining browser acceptance runs are
complete. The expanded sample looks positive or neutral rather than exposing a
clear whole-application regression. Quake II, the larger Fallout repeat, the
current-main one-map microbenchmark, and StarCraft in-browser are useful neutral
controls. Large variance in GTA2 and the single complete Diablo II pair still
prevent a universal-speedup claim.

Prefer the flat-table follow-up over the demand-leaf prototype for eventual
integration. Its extra memory is fixed and modest, its lookup is no slower in
the measurements, and it removes the conditions that required a legacy
translation fallback. A separate hot cache is not justified by the current
data: the flat lookup already removed the one-map regression.

Before integrating:

1. Repeat fixed-work **browser** A/Bs for Heroes II/III, Diablo, Diablo II, and
   Alpha Centauri with rotated arm order; StarCraft is neutral, while D2 has a
   healthy CLI baseline but only one complete pair.
2. Only then layer optional audit/enforcement of `VirtualAlloc` and
   `VirtualProtect` access flags onto the chosen translator.
