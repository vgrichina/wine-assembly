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

The opt-in `--guest-page-translation` path leaves direct and DIB translation
unchanged. Sparse mappings use a demand-allocated two-level table:

```text
guest address
  | bits 30..20              bits 19..12       bits 11..0
  v                          v                 v
8 KiB directory ----> 1 KiB leaf ----> packed PTE + byte offset
  2048 slots          256 pages        backing page | access bits
```

The 1 MiB leaf arena can represent 1024 populated 1 MiB guest ranges. If an
address or leaf cannot be represented, a shared fallback bit keeps the old
range cache/record walk authoritative. Sparse commits publish PTEs before the
mapping becomes visible; release clears PTEs before backing can be reused.
Enabling the option backfills existing mappings while holding the shared
virtual-map lock, then makes later allocations publish across worker instances.

The default remains off. Off-mode memory operands retain the established path;
only sparse allocation/free performs a shared active-bit check.

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

Each row below uses four legacy and four packed runs in the interleaved order
off/on/on/off/on/off/off/on. Wall and user CPU medians are reported separately;
the exact batch count and input schedule were held constant. This is CLI
translator evidence, not a claim about headful browser frame rate.

| Application and sampled path | Legacy median | Packed median | Interpretation |
| --- | ---: | ---: | --- |
| Fallout demo, 8,000-batch early load | 1.315s wall / 1.370s CPU | 1.220s / 1.300s | preliminary 7.2% wall and 5.1% CPU reduction |
| Half-Life Uplink, 1,000-batch renderer startup | 19.055s / 17.275s | 17.495s / 16.460s | noisy preliminary 8.2% wall and 4.7% CPU reduction |
| Age of Empires II, 400-batch first-run flow | 0.310s / 0.325s | 0.320s / 0.335s | too short for a speed claim; effectively neutral |
| GTA2 demo, 4,500-batch gameplay entry | 9.080s / 7.715s | 7.715s / 6.830s | variance is large; neutral-to-positive, with no demonstrated regression |
| Quake II demo, 1,200-batch GL startup | 2.205s / 2.190s | 2.200s / 2.205s | neutral within measurement noise |

Correctness pairs reached the same fixed-work boundary in both modes. The
Fallout title, Half-Life startup, AoE II first-run frame, GTA2 Wild Demo frame,
and Quake II renderer frame were byte-identical between modes. GTA2 also ended
with identical thread/CPU state and execution counters; Quake II ended with
identical execution counters. The long Fallout pair had severe run-order drift
(56.41s/36.94s then 35.05s/22.32s), which is why only its shorter interleaved
series is used above.

## Verdict

Keep the candidate opt-in and isolated; do not enable it by default yet. The
expanded sample now looks positive or neutral rather than exposing a clear
whole-application regression. Fallout and Half-Life extend the promising set;
Quake II supplies a useful neutral control. Large variance in GTA2 and the
single complete Diablo II pair still prevent a universal-speedup claim.
Before integrating:

1. Count packed hits, misses, legacy cache ranks, and record-scan depth in real
   gameplay without enabling counters in production runs.
2. Compare the two-level candidate with a full 4 MiB page table and a one-entry
   hot sparse-range/page cache. A full table can cover the complete 32-bit guest
   space and remove leaf-exhaustion fallback complexity; putting all four
   legacy range checks ahead of packed lookup would penalize fragmented cases.
3. Repeat fixed-work **browser** A/Bs for Heroes II/III, Diablo, StarCraft,
   Diablo II, and Alpha Centauri with rotated arm order; D2 now has a healthy
   baseline but only one complete pair.
4. Only then layer optional audit/enforcement of `VirtualAlloc` and
   `VirtualProtect` access flags onto the chosen translator.
