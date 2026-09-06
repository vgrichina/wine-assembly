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

## Verdict

Keep the candidate opt-in and isolated; do not enable it by default yet.
Heroes III and the scattered-map microbenchmark justify continued measurement,
but the other applications do not establish a broad win. Before integrating:

1. Count packed hits, misses, legacy cache ranks, and record-scan depth in real
   gameplay without enabling counters in production runs.
2. Repeat fixed-work browser A/Bs for Heroes II/III, Diablo, StarCraft, Diablo
   II, and Alpha Centauri with rotated arm order; D2 now has a healthy baseline
   but only one complete pair.
3. Only then layer optional audit/enforcement of `VirtualAlloc` and
   `VirtualProtect` access flags onto the chosen translator.
