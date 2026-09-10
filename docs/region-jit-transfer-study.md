# Carrying toyvm's live region JIT into the WAT x86 interpreter — a measurement study

**Status: measurement and design study. No `src/*.wat` or `lib/*.js` was changed.
Recommendation at the end is DO A NARROWER THING.**

```
                     what a region JIT can remove, measured
     ┌──────────────────────────────────────────────────────────────┐
     │ block transfers INTERNAL to a single-entry call-free region   │
     │  caesar 25.2%   heroes2 29.2%   TA 66.1%   jazz2 73.3%        │
     │  diablo 77.5%                     (share of ALL transfers)    │
     │                                                               │
     │ and they are CONCENTRATED: 1-4 regions carry 50% of them,     │
     │ 2-9 carry 80%.  This is ten hot loops, not a thousand.        │
     └──────────────────────────────────────────────────────────────┘
     ┌──────────────────────────────────────────────────────────────┐
     │ but the WAT interpreter has already taken most of the cheap   │
     │ half: page compilation fuses not-taken Jcc fall-through, so a │
     │ hot region ALREADY costs one `$run` lookup per taken branch   │
     │ and zero per fall-through.  Caesar retired 40.0M blocks in a  │
     │ window that cost only 32.9M lookups.                          │
     └──────────────────────────────────────────────────────────────┘
     ┌──────────────────────────────────────────────────────────────┐
     │ and the install mechanism does NOT carry over.  toyvm swaps   │
     │ the whole VM module.  Ours is 1 MB across up to 8 per-thread  │
     │ instances, and every x86 register is a per-instance wasm      │
     │ GLOBAL — unreachable from a separately-instantiated region    │
     │ module.  That precondition, not the profitability, is the     │
     │ blocking issue.                                               │
     └──────────────────────────────────────────────────────────────┘
```

Companion tool: **`tools/block-regions.js`** (added with this doc). Everything
numeric below is reproducible from it plus the run commands in section 2.

---

## 1. What the question actually is, after reading the WAT decoder

`docs/toyvm-region-live.md` describes a JIT that picks a hot self-loop region,
compiles it to a fresh wasm module, and installs it as an **extra entry
appended to the handler table** so every index already in the arena still names
the same handler. The question posed was what that would buy here.

Reading `src/07-decoder.wat` first changes the question. Two things the WAT
interpreter already does that toyvm's does not:

* **`$decode_run` fuses fall-through.** When a block ends in a Jcc, the decoder
  keeps going and lays the not-taken successor down as the *next op of the same
  thread stream* (`src/07-decoder.wat`, the `$decode_run` comment block at
  ~line 5320). So the not-taken side of a branch costs **no** `$run` lookup and
  **no** block transfer. Design B's headline saving — "remove the back-edge
  `cache_lookup(eip)`" — is already collected on every fall-through edge.
* **`$hot_block_hist_record` is called from `$run`'s block-entry loop**
  (`src/13-exports.wat:255`), not from the decoder and not per basic block. So
  a hit in a `--hot-block-dump` is not "a basic block executed". It is exactly
  one **interpreter block transfer**: an EIP that had to be resolved through the
  page index before anything could run.

That makes the dump the right instrument for this question and turns the study
into arithmetic rather than estimation: **a live region JIT can delete exactly
the block transfers that are internal to a compiled region, and nothing else.**
Everything in section 3 is that number, per app, exactly.

The other half — how much of a *dispatch* survives inside a compiled region —
is not measurable from here and is where toyvm's gate ratios and the
`bench-loops.js` primitives (8 ns/dispatch, 9 ns/block transfer) come in.
Section 4 does that conversion and section 4.3 says why the answer lands at the
*bottom* of toyvm's measured gate range rather than the middle.

### 1.1 What the tool measures

`tools/block-regions.js` takes a hot-block dump plus the PE images with their
runtime load bases, rebuilds the x86 CFG by **recursive descent** from every
dumped address (not a linear sweep — data in code is never decoded unless
something branched to it), finds strongly-connected components, and buckets
every dumped address:

| class | definition | whose territory |
|---|---|---|
| `selfloop` | one node, branches to itself, call-free, no indirect transfer | **Design A** — the shape `src/07b-loop-match.wat` already folds |
| `region` | SCC of ≥2 nodes, no `call`, no `ret`, no indirect branch, entered from outside at exactly one node | **Design B / toyvm** |
| `region-multi` | same but entered at 2+ nodes (a compiled region could still take it behind an entry switch) | Design B with a prologue |
| `loose` | in a cycle, but the cycle contains a call / ret / indirect branch | needs a call-out protocol |
| `acyclic` | in no cycle within the executed set | nothing to compile |
| `unmapped` | not inside any supplied image (runtime-generated code) | invisible to any static plan |

Two attribution rules matter for reading the tables:

* **Transfers are exact.** They are the dump, bucketed.
* **x86-instruction counts are a proxy for in-region dispatch share, and they
  are a *lower* bound**: a block reached only through fused fall-through takes
  no lookup, so it carries no hits and its instructions are not counted at all.

---

## 2. What was run

Fixed work per app (`--max-batches`, not a time budget), `--quiet-api`, one
profiling window each, `--handler-hist-thread=0 --hot-block-dump=…
--batch-stats --decode-stats`. The box sat at load 13–38 for the whole session,
so **no wall-clock number below is a speed claim**; user CPU is quoted only
where it is an input to a per-op figure.

| app | window | drive |
|---|---|---|
| `caesar3_demo` | batches 3600–4400, live city | the click/type schedule of `test/test-caesar3-gameplay.js`, replayed through `--input` |
| `heroes2_demo` | batches 1400–2600, gameplay | the reproduction command in `docs/re-notes/heroes2-demo.md` |
| `diablo_shareware` | batches 45500–47000, Tristram | the cheap-clock recipe in `docs/re-notes/diablo-shareware.md` |
| `total_annihilation_demo` | batches 2000–3000, animated title | the app §10.6 of the superops doc used for the COPY_RUN census |
| `jazz2_demo` | batches 1200–2000, in game | plain launch |

Raw totals for the windows:

| app | dispatches | block transfers | dispatches / transfer | distinct block-entry addrs | hist collisions |
|---|---:|---:|---:|---:|---:|
| caesar3_demo | 150,825,652 | 32,914,958 | 4.6 | 1844 | 0 |
| heroes2_demo | 104,794,817 | 23,977,486 | 4.4 | 1080 | 0 |
| diablo_shareware | 26,845,454 | 5,999,190 | 4.5 | 1260 | **810** |
| total_annihilation_demo | 219,387,993 | 47,529,656 | 4.6 | 668 | 0 |
| jazz2_demo | 245,745,379 | 15,990,528 | **15.4** | 1761 | 5 |

**Read the collision column before quoting Diablo.** The hot-block histogram is
a bucketed structure; `docs/loop-microbench-harness.md` records a case where the
recorded half alone was 44% short. 810 collisions on 1260 addresses means
Diablo's dump is missing entries, so its shares are the least trustworthy of
the five. Caesar, Heroes II and TA are clean.

**`dispatches / transfer` is the single most useful number in the table.** Four
of the five apps sit at 4.4–4.6 and jazz2 at 15.4. That ratio is how far the
per-transfer cost is amortized, and it is what decides whether removing
transfers is worth anything (section 4.4).

---

## 3. The census

### 3.1 Share of block transfers by class (exact)

| app | selfloop | region | region-multi | loose | acyclic | unmapped |
|---|---:|---:|---:|---:|---:|---:|
| caesar3_demo | 0.0% | **28.2%** | 0.0% | 38.4% | 33.4% | 0.0% |
| heroes2_demo | 0.1% | **34.1%** | 0.0% | 32.8% | 33.0% | 0.0% |
| diablo_shareware | 0.4% | **86.5%** | 0.0% | 6.5% | 6.6% | 0.0% |
| total_annihilation_demo | 12.7% | **66.5%** | 0.1% | 7.6% | 13.1% | 0.0% |
| jazz2_demo | 0.9% | **93.6%** | 0.0% | 4.0% | 1.1% | 0.4% |

### 3.2 Share of retired x86 instructions by class (lower bound, proxy for in-region dispatch share)

| app | selfloop | region + multi | loose | acyclic |
|---|---:|---:|---:|---:|
| caesar3_demo | 0.0% | **14.2%** | 25.9% | 59.9% |
| heroes2_demo | 0.4% | **37.3%** | 30.4% | 31.9% |
| diablo_shareware | 0.5% | **86.9%** | 6.0% | 6.6% |
| total_annihilation_demo | 16.7% | **60.3%** | 6.9% | 16.1% |
| jazz2_demo | 0.8% | **96.3%** | 2.4% | 0.4% |

Note the gap for Caesar: 28.2% of *transfers* but only 14.2% of *instructions*
sit in regions. Caesar's regions are tight loops with short bodies; its bulk
work is elsewhere. The reverse never happens in this corpus.

### 3.3 The number that actually prices a region JIT: internal transfers

A region's entry node keeps its hits — something outside branched in and a
compiled region still has to be entered. Every **other** node's hits are
transfers a compiled region deletes outright. That number is exact:

| app | internal (deletable) transfers | share of ALL transfers | regions carrying 50 / 80 / 90% |
|---|---:|---:|---:|
| caesar3_demo | 8,290,021 | **25.2%** | 2 / 3 / 4 |
| heroes2_demo | 7,002,767 | **29.2%** | 1 / 2 / 2 |
| diablo_shareware | 4,646,546 | 77.5% (see collisions) | 4 / 9 / 11 |
| total_annihilation_demo | 31,424,000 | **66.1%** | 1 / 2 / 3 |
| jazz2_demo | 11,719,853 | **73.3%** | 1 / 2 / 3 |

They are also small: the tool reports each region's guest byte span and page
count, and **every region in the top 8 of all five apps fits inside one 4 KB
page** (largest 1033 bytes; the single hottest, TA `0x0048eab5` with 23.58 M
internal transfers, is 211 bytes across 33 blocks).

**Question 3 of the brief is answered decisively: it is ten hot loops, not a
thousand.** Across five apps, between one and four regions carry half the
in-region transfers and between two and nine carry 80%. That is the strongest
single result here, because it is what makes a 1.2–5.5 s off-thread compile per
region (toyvm's measured cost) affordable at all: a working set of ~10 compiled
regions per app, not hundreds.

### 3.4 What the top region actually is — Heroes II, worked

The top Heroes II region is `0x004c7341`: **70 nodes, 345 x86 instructions, one
external entry, no call, no ret, no indirect branch**, carrying 1,051,336 entry
transfers and **5,377,910 internal transfers = 22.4% of every block transfer in
the window**. `tools/block-regions.js --region=0x4c7341` prints it; the head of
the listing is:

```
0x004c7341  insns=  7  end=jcc    hits= 1,051,336  jge 0x4c7651
0x004c735b  insns=  2  end=jcc    hits=   556,081  jnz short 0x4c737d
0x004c735f  insns=  5  end=jcc    hits=   252,881  jz 0x4c7746
0x004c7379  insns=  2  end=jmp    hits=   240,181  jmp short 0x4c7341
...
0x004c755d  insns=  9  end=jcc    hits=   141,826  jnz short 0x4c755d
...
0x004c74fc  insns=  2  end=fall   hits=    40,669  rep stosb
0x004c7700  insns=  6  end=fall   hits=   282,122  rep movsb
0x004c7645  insns=  3  end=jmp    hits=   262,530  jmp 0x4c7341
```

This is the exact function §1 and §10.1 of `docs/loop-idiom-superops-design.md`
name: four of its blocks (`0x004c7341` 5.03%, `0x004c735b` 2.65%, `0x004c7651`
2.44%, `0x004c755d` 2.29%) are **12.4% of all dispatches**, and Design A can
take only `0x004c755d` — the other three "decline as `multi-branch`". LUT_RUN
took that one block from 229,515 entries to 62,544 and measured **−2.70% of all
handler dispatches and a wash in time**.

**The whole function is one region.** Design B does not need any of Design A's
predicates to swallow it; it needs only that the SCC is call-free and
single-entry, which it is. This is the clearest statement of what regions buy
over idiom lowering that this corpus contains.

Two things in the listing are also the argument *against* over-claiming: the
loop's two heaviest leaves are `rep stosb` and `rep movsb`, which are already
**one dispatch each** (`src/05b-string-ops.wat` never touches `$steps`, so a
64 KB `rep movsd` costs one step). A region cannot make those cheaper.

### 3.5 Why `call` is the whole generality story

`call` is the top decline reason in all five apps (55, 34, 59, 20, 71 cycles
declined). Re-running the same census with a call treated as an internal edge
(`--allow-calls`, an upper bound — it says nothing about whether the callee is
small enough to inline) moves the deletable share a long way:

| app | internal transfers, call-free | with calls allowed |
|---|---:|---:|
| caesar3_demo | 25.2% | **61.3%** |
| heroes2_demo | 29.2% | **46.6%** |
| diablo_shareware | 77.5% | 83.6% |
| total_annihilation_demo | 66.1% | 72.7% |
| jazz2_demo | 73.3% | 74.4% |

For the two apps where a call-free region JIT looks weakest — Caesar and
Heroes II — allowing calls is worth more than the entire call-free design. This
is the same finding `docs/loop-idiom-superops-design.md` §9.4 reached
statically from the other direction (`call` 2299 + `multi-branch` 1029 = 58% of
all Design-A declines), and it lands in the same place: the call boundary, not
the loop shape, is the constraint.

### 3.6 Self-loops: mostly already gone, and where they are not

`selfloop` is at or below 1% of transfers in four of five apps. The exception is
**Total Annihilation at 12.7% of transfers / 16.7% of instructions**, in four
blocks:

```
0x0048e14a  insns=6  hits= 2,880,000  jnz short 0x48e14a
0x004901e2  insns=6  hits= 2,448,025  jnz short 0x4901e2
0x004901b1  insns=6  hits=   624,000  jnz short 0x4901b1
0x0048e13c  insns=6  hits=    80,000  jnz short 0x48e13c
```

Six-instruction self-loops taking one block transfer per iteration — precisely
COPY_RUN's constituency, and precisely the case §10.6 measured: 1,044,252
iterations collapsed to 245,077 invocations and the A/B came back **3.24 s on
against 3.21 s off**. `--copy-superops` remains off by default. **A region JIT
would fold the same four loops and has no reason to do better than COPY_RUN
did**, because what it removes there (dispatch + transfer) is not what those
loops cost (translated per-byte memory access, priced by the microbench harness
at 428–644× `memory.copy`).

### 3.7 Question 4: what is already taken

The handler histogram for each window says what the regions contain that the
interpreter already collapses.

* **Caesar (city window)**: no `H418` (LUT_RUN), no `H424` (RLE_RUN), no `H431`
  in the top 24. The visible fusions are `H404 $th_test_jcc` 1.87% and
  `H407 $th_alu_m32_i_jcc` 1.65%. But the **fusion ratio is 0.69 dispatches per
  x86 instruction** — the lowest of the five — so roughly a third of Caesar's
  retired x86 instructions already cost no dispatch at all. That is the cheap
  half of a region JIT's job, done at decode time, for free, with no install and
  no invalidation.
* **Heroes II**: fusion ratio 0.93. `H404` 4.12%, `H405 $th_store32_abs_run`
  1.94%, `H406 $th_load32_abs_run` 1.60%, `H148 $th_lea_sib` 2.62%.
* **TA**: fusion ratio 1.01. `H149 $th_compute_ea_sib` 6.87% — the hot self-loop
  bodies are already running specialised SIB handlers.
* **jazz2**: fusion ratio 1.07, and **67.1% of its dispatches are x87**
  (`H189 $th_fpu_reg` 33.4%, `H190 $th_fpu_mem_ro` 28.5%, `H188 $th_fpu_mem`
  5.2%). Its 96.3% in-region instruction share is real and its payoff is not:
  the cost is in the FPU handler *bodies*, which a compiled region still has to
  call. Its 15.4 dispatches per transfer says the same thing from the other end.

**jazz2 is the counterexample that has to be carried into the recommendation.**
The largest in-region share in the corpus belongs to the app where a region JIT
has the least to remove. In-region share alone is not a payoff estimate; it has
to be weighted by what fraction of the region's time is interpreter machinery
rather than handler body.

### 3.8 Decode and invalidation pressure (an input to the install design)

| app | block decodes (whole run) | evicted a live block | page index hit rate |
|---|---:|---:|---:|
| caesar3_demo | 9,494,385 | 0 | 91.1% |
| heroes2_demo | 1,438,098 | 12 | 95.9% |
| diablo_shareware | 32,206,983 | 12 | **66.5%** |
| total_annihilation_demo | 3,706,595 | 0 | 95.5% |
| jazz2_demo | 1,475,045 | 0 | 93.6% |

Diablo re-decodes 32.2 M blocks at a 66.5% page-index hit rate. Diablo
"generates its copier at runtime" (`project_rle_nest_census`), and §14 of the
superops doc records `storm.dll`'s MPQ decompressor as the one place COPY_RUN
ever fired in it. **A region compiled over pages Diablo rewrites is a region
that is invalidated constantly**, and Diablo is also the app with the highest
apparent in-region share. Those two facts point in opposite directions and the
census cannot resolve which wins; only an implementation could.

---

## 4. What the numbers predict

### 4.1 The primitive-cost arithmetic

`docs/loop-microbench-harness.md` prices **one dispatch ≈ 8 ns** and **one block
transfer ≈ 9 ns on top of the dispatch that caused it**, with the standing
caveat that the harness *understates dispatch cost by construction* (a periodic
loop lets the BTB predict every `call_indirect`, and the mispredict is the
~23% `$next` cost) and the standing rule **never quote a microbench % as an
app %**.

Applying it: a region JIT deletes `9 ns × internal transfers` outright, and
converts `8 ns × in-region dispatches` of dispatch overhead into inline control
flow. In-region dispatches are estimated as (x86-instruction share) × dispatches.

| app | internal transfers × 9 ns | in-region dispatches × 8 ns | total | as % of `8·D + 9·B` |
|---|---:|---:|---:|---:|
| caesar3_demo | 74.6 ms | 171.3 ms | 246 ms | 16.4% |
| heroes2_demo | 63.0 ms | 312.7 ms | 376 ms | 35.6% |
| diablo_shareware | 41.8 ms | 186.6 ms | 228 ms | 85.0% |
| total_annihilation_demo | 282.8 ms | 1058.3 ms | 1341 ms | 61.4% |
| jazz2_demo | 105.5 ms | 1893.2 ms | 1999 ms | 94.7% |

Those last two columns are the *machinery* budget, not the run. Converting them
to a run needs a real profile.

### 4.2 The profile-anchored arithmetic (Caesar only, because that is the one profile that exists)

`docs/interpreter-dispatch-perf.md` has a corrected `node --prof` table for a
Caesar III gameplay profile:

| function | % of total ticks | % of wasm ticks |
|---|---:|---:|
| `$next` | 14.1% | 26.2% |
| `$run` | 9.4% | 17.6% |
| `$get_reg` + `$set_reg` | 8.4% | 15.5% |
| `$g2w` | 3.1% | 5.8% |

A compiled region removes, for the code inside it: **all** of `$next`; the
`$run` block-entry loop for its *internal* transfers only; and most of
`$get_reg`/`$set_reg`, because a region holds x86 registers in wasm locals. It
does **not** remove `$g2w` — memory is still translated per access — and it does
not remove the handler body work.

```
saving  ≈  s_insn × 14.1%                     ($next)
        +  internal_share × 9.4%              ($run)
        +  s_insn × 8.4% × ~0.7               (register file → locals)
```

| app | s_insn | internal | predicted saving, % of process ticks | % of wasm ticks |
|---|---:|---:|---:|---:|
| caesar3_demo | 14.2% | 25.2% | **5.2%** | 9.7% |
| heroes2_demo | 37.3% | 29.2% | 10.2% | 19.0% |
| diablo_shareware | 86.9% | 77.5% | 24.7% | 46.0% |
| total_annihilation_demo | 60.3% | 66.1% | 18.3% | 34.1% |
| jazz2_demo | 96.3% | 73.3% | 26.1% | 48.6% |

**Only the Caesar row is anchored.** The other four apply Caesar's profile
*shape* to a different app's census, and section 3.7 already shows that shape
does not hold for jazz2 — two thirds of its dispatches are x87 handlers whose
bodies dwarf `$next`, so its 26.1% is an overestimate by an unknown factor.
Getting real numbers for the other four means `--cpu-prof` per app, which this
study did not take.

Also note ~15% of Caesar's CLI ticks are JS rasterisation that no dispatch
change touches; in the browser the same saving is a larger share of a smaller
process.

### 4.3 What gate ratio this implies, and why it is at the bottom of toyvm's range

toyvm measured per-region gate ratios of **1.59×–8.28×** (median around 2.7×)
for its regions against its tier-0 interpreter, with the explicit warning that
the same DRAGON region measured **2.62× and 0.84× an hour apart** on a loaded
box.

Turning the section 4.2 rows around: Caesar removes 5.2 points of process time
from a region holding 14.2% of the instructions → **37% of in-region time, an
implied gate of 1.58×**. Diablo: 24.7 of 86.9 → 28%, gate **1.40×**.

**That is the bottom of toyvm's range, and it should be.** toyvm's tier 0 is a
plain threaded interpreter. Ours already has:

* page compilation with fall-through fusion (`$decode_run`), so internal
  not-taken edges are already free;
* ~130 specialised and fused handlers (`$th_load32_ro_base_ebp`,
  `$th_test_jcc`, `$th_alu_m32_i_jcc`, `$th_store32_abs_run`,
  `$th_compute_ea_sib`), visible as a fusion ratio of **0.69–1.07 dispatches
  per x86 instruction**;
* the shipped Design-A superops (LUT_RUN on by default, H431, RLE_RUN,
  CASE_CHAIN);
* `rep`-string ops as single dispatches.

Every one of those is overhead a region JIT would otherwise have been paid to
remove, already removed at decode time with no install, no compile latency and
no invalidation protocol. **The prize is real but it has been pre-spent, and
the expected gate is ~1.4–1.6×, not 2.7×.**

**And note what toyvm's own speed result actually is**, because it is easy to
carry across in the wrong shape. Its per-program table is a mean of **+1.2%
dispatches per CPU-second at 12 M and +2.3% at 80 M**, with per-row swings from
**−27.1% to +67.6%** at 12 M — every figure taken on a box at load 40–173, and
with the same DRAGON region gating at **2.62× and 0.84× an hour apart**. Only
10 of its 20 programs got a region at all, and in-region budget share ran from
2.5% to 97.5%. toyvm's transferable claims are structural: the
handler-table-append install, the three invalidation mechanisms, the
one-dispatch clock bound, and the 1.2–5.5 s compile / 9–31 ms install costs.
**Its speed numbers are not evidence for anything here.**

### 4.4 The two standing negative results this has to answer to

The repo has measured, twice, that removing dispatches does not remove time:

* **LUT_RUN on Heroes II**: −2.70% of all handler dispatches, 166,971 block
  round trips removed, pixel-identical, **a wash** in time.
* **COPY_RUN on Total Annihilation**: a hot loop's 1,044,252 iterations
  collapsed to 245,077 invocations, `hot%` 31.5 → 27.2, **3.24 s on vs 3.21 s
  off**.

And `project_next_dispatch_negative` states it as a rule: fewer dispatches is
not automatically faster. And `project_caesar_fold_class_ab`: **fold memory, not
control flow** — `rect_run` +12%, `case_chain` ~0%.

A region JIT is not obviously exempt. What it does differently is remove three
things at once instead of one: dispatch, *block transfer*, and *register-file
traffic*. LUT_RUN and COPY_RUN removed only the first. `$run` at 17.6% of wasm
and `$get_reg`/`$set_reg` at 15.5% are between them larger than `$next`'s 26.2%
— and `docs/accessor-fastpath-split.md` shows the register half is genuinely
stuck: **`$next` is denied inlining at sites carrying 3.15 M calls and
`$set_reg` at 1.32 M with zero inlined**, and the ~8–13% that
`--wasm-inlining-min-budget=600` is worth is exactly that dispatch/register
shape.

So the honest statement is: *the mechanism that failed twice addressed one third
of the machinery; a region addresses all three thirds.* That is a reason to
expect a different outcome, not a proof of one — and the failure mode of every
previous attempt was believing exactly that.

---

## 5. Install mechanism sketch for the WAT side

This is where the study stops being encouraging.

### 5.1 toyvm's mechanism does not carry over

toyvm installs a region by **instantiating a fresh module over the same imported
memory and carrying every mutable global across** (`carryState`: machine state,
registers, machine state again). Measured cost 9–31 ms per install, on a module
whose bundle is ~1 MB.

Three reasons that does not transfer:

1. **Module size and tiering.** `build/wine-assembly.wasm` is 1,049,813 bytes.
   Re-instantiating it throws away every byte of V8's optimised wasm code for
   the *whole interpreter* on every install; the interpreter then re-tiers from
   scratch. toyvm's 9–31 ms is an instantiate cost, not a re-tier cost, and the
   re-tier is the one that matters for a 1 MB module whose hot function is
   `$next`.
2. **Per-thread instances.** Guest threads are separate WASM instances over one
   shared memory (`lib/thread-manager.js`), up to 8, each with its own
   `0x3C0000` thread-cache partition. `feedback_per_instance_globals` records
   that **every mutable global has to be propagated at worker spawn**. An
   install would have to be replayed on every live instance, in lockstep, with
   the guest parked.
3. **The register file is per-instance wasm globals.** This is the blocking
   one. A region compiled as a *separate* module cannot read `$eax` at all —
   wasm globals are per-instance and not shared. So the only two shapes are
   (a) swap the whole interpreter module (points 1 and 2), or (b) make the
   register file reachable from another instance.

### 5.2 The shape that would actually work: a sidecar module in a growable table

The design that avoids re-instantiating the interpreter:

```
  interpreter module                         region module (compiled at runtime)
  ┌──────────────────────────┐               ┌───────────────────────────────┐
  │ (import "host" "memory") │◄──shared──────│ (import "host" "memory")      │
  │ (table $handlers … )     │◄──table.set───│ (func $region_0x4c7341 …)     │
  │   … N fixed handlers …   │   from JS     │   reads/writes the register    │
  │   [N]   ← region slot    │               │   file THROUGH LINEAR MEMORY   │
  │   [N+1] ← region slot    │               │   calls back for $g2w, $steps  │
  └──────────────────────────┘               └───────────────────────────────┘
```

* **Handler table.** `src/02-thread-table.wat` declares
  `(table $handlers N funcref)` with a build gate
  (`tools/check-handler-count.js`) that N matches the `(elem …)` count. A live
  region needs either a **reserved tail of empty slots** (simplest: declare
  N+32, gate the extra) or a **growable table** exported to JS. Either is a
  change to a gated invariant. **Needs the user's sign-off.**
* **`$next` needs no change at all.** A region is just another handler index;
  `$te(region_id, operand)` in the thread stream dispatches to it exactly like
  any other op. This is the one part of toyvm's design that transfers cleanly.
* **The block cache and page index are the right hook, and already exist.** A
  region is emitted by the decoder in place of the block at its entry address,
  published into that entry's page chunk. The page's byte-range index and
  per-page version counters (`$invalidate_page`,
  `docs/page-compile-design.md`) then invalidate the region for free when the
  guest writes any byte it covers — this is precisely toyvm's `regionBytes` +
  `regionCodeBits` mechanism, and we already have it. **A region must live in
  exactly one page**, which the existing `$decode_run` page constraint already
  enforces and which caps region size at 4 KB of guest code. **Measured: every
  region in the top 8 of every one of the five apps fits inside one 4 KB
  page** — the tool prints `bytes=N/Mpg` and no region in the corpus reported
  M > 1. The largest are Heroes II `0x004c7341` (70 nodes, 1029 bytes) and
  `0x004cbbb3` (66 nodes, 1033 bytes); the hottest of all, TA `0x0048eab5`
  (33 nodes carrying 23.58 M internal transfers), is **211 bytes**. So the
  existing per-page index and version counters are a sufficient invalidation
  substrate for the regions that matter, with no new mechanism.
* **Thread partitions.** A region module installed into the shared table is
  visible to every instance immediately, which is *better* than the swap
  design — but only if the region reads no per-instance state. Which brings
  back the register file.
* **The precondition.** A sidecar region module can only work if the x86
  register file is in **linear memory**, not in wasm globals. That is exactly
  the shelved `perf/reg-file-in-memory` branch measured in
  `docs/interpreter-dispatch-perf.md`: **12,813 direct global sites + 325
  indirect rewritten, +4.7% code size, bit-identical dispatch count, never
  merged, never timed on a quiet box.** A region JIT makes that branch a
  prerequisite rather than an experiment — and it would have to be paid for
  first, on its own, with its own timing evidence.

### 5.3 What the diagnostics would have to show

* **`--batch-stats`** must grow a stop reason for "region ran". Today a batch
  stops on budget / EIP zero / yield / blocking wait / debug facility; a region
  that retires 2,000 blocks' worth of work in one dispatch has to bill
  `$block_budget` for them or the headless clock (`batch × TICK_MS_PER_BATCH`)
  silently speeds up. `project_rle_run_fold` already had to do exactly this —
  "bill `block_budget` from a hot-block dump" — and toyvm's equivalent
  invariant is "a region charges `$steps` per op precisely so the dispatch
  count does not move". **Assume this is load-bearing and get it wrong at your
  peril**: toyvm's DREAM.EXE diverged at 80 M dispatches over a one-dispatch
  slice overshoot, and 2 of 191 corpus programs drew a different picture from
  inside a region that a 4,000-iteration audit had passed.
* **`--decode-stats`** must separate "block decode" from "region compile", and
  report compile latency and count. toyvm pays 1.2–5.5 s per region off-thread;
  the CLI has no off-thread compile path, and a synchronous 1.2 s stall inside
  a batch is worse than any saving it could deliver in the same run.
* **A new counter: regions installed / invalidated / re-installed.** Diablo's
  66.5% page-index hit rate says this counter decides whether the feature is
  live or thrashing, and no existing diagnostic can see it.
* **`--handler-hist`** already handles it: region handlers are numbered above
  the fixed count and the histogram sums the whole counter array
  (`$HANDLER_HIST_COUNT` is 512, gated). But the *pair* matrix is `count ×
  count` and would not see region pairs, and the hot-block histogram is a
  bucketed structure that already loses entries (810 collisions on Diablo).

### 5.4 Language and build features required — flagged for sign-off

| feature | needed for | sign-off? |
|---|---|---|
| **Runtime `WebAssembly.compile` / `instantiate` in the browser and in `run.js`** | compiling a region at all | **YES** — the browser currently compiles once from `main.watx` at load; per-region runtime compilation is a new capability, a new bundle dependency (toyvm's JIT bundle is 1415 KB vs 1052 KB), and a CSP/security surface |
| **Handler-table growth** (`table.grow`, or a reserved gated tail) | installing a region as an extra handler index | **YES** — `tools/check-handler-count.js` gates table size against the `(elem …)` count today; both options change that invariant |
| **x86 register file in linear memory** (or mutable *imported* globals) | a sidecar region module reading guest state | **YES** — this is `perf/reg-file-in-memory`, 12,813 rewritten sites and +4.7% code size, currently unmerged and untimed |
| **A WATX construct for emitting a wasm module at runtime** — or, more likely, a JS-side region compiler that emits wasm bytes directly | turning a threaded-op list into a module | **YES** — `feedback_watx_lang_features_need_signoff`: design freely, but confirm before implementing |
| Exporting the handler table to JS | `table.set` from the install path | probably yes, bundled with table growth |
| Off-thread compile (Worker in browser, `worker_threads` in CLI) | keeping a 1.2–5.5 s compile off the guest thread | no new language feature, but new plumbing on both hosts |
| A region **audit** harness (run the region and tier 0 from the same state, compare every register and byte) | correctness | no sign-off, but it is the largest single piece of work, and toyvm's version still cannot say "I never took that exit" |

---

## 6. Recommendation

### Do a narrower thing.

**Not** a general live region JIT. **Yes** to two things it depends on, in
order, each measurable on its own.

**The case for the full thing, stated fairly.** The structure is there and it
is better than expected: 25–77% of all block transfers are internal to
single-entry call-free regions; one to four regions carry half of them; Heroes
II's entire hot sprite blitter — the function that is 12.4% of its dispatches
and that Design A can only nibble at one block of — is a single 70-node,
345-instruction, call-free, single-entry region. A region removes dispatch,
block transfer and register traffic at once, where the two shipped superop
families removed only dispatch and measured a wash both times.

**The case against, which is the one the numbers support.**

1. **The expected gate is ~1.4–1.6×, not toyvm's 2.7× median** (§4.3), because
   the WAT interpreter has already spent the prize: page compilation with
   fall-through fusion, ~130 specialised/fused handlers (fusion ratio
   0.69–1.07 dispatches per x86 instruction), Design-A superops, `rep` as one
   dispatch. On Caesar — the app with the only real profile — that is a
   predicted **5.2% of process time**, against a repo noise floor of 24–42% on
   whole-app A/B and an explicit finding that *this box cannot time these
   changes*.
2. **In-region share is not payoff.** jazz2 has the largest in-region share in
   the corpus (96.3%) and the least to gain, because 67.1% of its dispatches
   are x87 handler bodies. Any go/no-go taken from §3 alone would pick exactly
   the wrong app.
3. **The install mechanism does not port** (§5.1). toyvm swaps its whole VM
   module; ours is 1 MB across up to 8 per-thread instances, and every x86
   register is a per-instance wasm global. The sidecar shape that avoids the
   swap requires the register file to be in linear memory first — an unmerged,
   untimed +4.7%-code-size branch.
4. **Correctness surface.** toyvm ships its region JIT **off** because 2 of 191
   corpus programs draw a different picture from inside a compiled region, with
   a 4,000-iteration audit passing at 2.39× and 2.22× with every register and
   every byte matching. A WAT x86 interpreter with SEH, self-modifying code
   (Diablo: 32.2 M block decodes, 66.5% page-index hit rate), 410+ handlers and
   real threads has strictly more side-exit surface than toyvm does.
5. **`call` is the constraint, not loop shape** (§3.5). On the two apps where
   a call-free region JIT is weakest, allowing calls is worth more than the
   entire call-free design (Caesar 25.2% → 61.3%). Building the call-free
   version first means building the version that helps Caesar and Heroes II
   least.

**What to do instead, in this order:**

1. **Land and time `perf/reg-file-in-memory` on its own.** It is a
   prerequisite for any sidecar region design, it is already written, it is
   bit-identical in dispatch count, and `$set_reg` is inlined at **zero** of
   1.32 M call sites today. It has to be justified by its own number on a quiet
   box, not by a region JIT that may never be built. If it cannot be justified,
   the sidecar design is dead and only the whole-module swap remains — which
   §5.1 argues against on tiering grounds.
2. **Extend the Design-A matcher to multi-block single-entry call-free SCCs,
   at decode time, with no runtime compilation.** This is the narrow thing.
   `src/07b-loop-match.wat` today classifies the ops a *self-loop block* just
   emitted; the census says the shapes worth having are 3–70 block SCCs, and
   `$decode_run` already discovers and lays out exactly those blocks
   contiguously within one page (`extended 42,505 | blocks chained 79,132 |
   free fall-throughs 3,547,905` on Heroes II). A **statically-emitted
   multi-block wrapper handler** — one that drives an SCC's threaded ops
   internally and returns only on a real exit — captures the `$run` term
   (17.6% of wasm × 25–77%) and part of the `$next` term with **no runtime
   wasm compilation, no handler-table growth, no module swap, no install
   protocol, no audit harness, and no invalidation design beyond the per-page
   version counters that already exist.** That is Design B's original
   "self-loop wrap" (§4.2 of the superops doc) generalised from one block to an
   SCC, and the census is the evidence that generalising it is where the value
   is: self-loops are ≤1% of transfers in four of five apps, multi-block
   regions are 28–94%.
3. **Only if (2) shows a real, timed win, revisit runtime compilation** —
   and then bring back the numbers from (2) as the baseline, because a live JIT
   has to beat the static wrapper, not the current interpreter.

**Do not build the live region JIT now.** The structural finding — hot code is
a handful of large single-entry call-free regions, not a thousand small ones —
is the valuable result of this study, and it is *more* useful to (2) than to a
JIT, because a static wrapper can exploit exactly the same structure without any
of §5's sign-off list.

---

## 7. Reproducing this

```bash
# one census run (Heroes II shown; the other four are in section 2)
node test/run.js --app=heroes2_demo --batch-size=20000 --max-batches=2600 \
  --repaint-every=50 --quiet-api --quiet-blocks --no-close \
  --input='400:click:535:225,700:click:528:68,1200:click:283:373' \
  --handler-hist-thread=0 --handler-hist-start=1400 --handler-hist-stop=2600 \
  --hot-block-dump=/tmp/h2.blocks --batch-stats=1400 --decode-stats=1400

# the census (dispatch total is the `[handler-hist] … total=` line above)
node tools/block-regions.js --dump=/tmp/h2.blocks \
  --pe=test/binaries/candidates/heroes-2-demo/files/H2DEMOW.EXE \
  --pe=test/binaries/candidates/heroes-2-demo/files/MSS32.DLL@0x63f000 \
  --pe=test/binaries/candidates/heroes-2-demo/files/SMACKW32.DLL@0x767000 \
  --dispatches=104794817 --why --top=10

# one region in detail, and the call-boundary upper bound
node tools/block-regions.js --dump=/tmp/h2.blocks --pe=… --region=0x4c7341
node tools/block-regions.js --dump=/tmp/h2.blocks --pe=… --allow-calls
```

DLL load bases come from the run's own `DLL: NAME at 0xADDR` lines; a base left
off puts every block in that image in the `unmapped` class, which the tool
reports rather than hiding.

## 8. What this study did not measure

* **No wall-clock A/B of anything.** By instruction, and because
  `docs/interpreter-dispatch-perf.md` establishes this box cannot time these
  changes (noise floor 24–42% against effects of 5–8%).
* **No per-app `--cpu-prof`.** Only Caesar has a published profile, so only the
  Caesar row of §4.2 is anchored; the other four apply Caesar's profile shape
  and §3.7 shows that is wrong for at least jazz2.
* **In-region dispatch share is proxied by x86-instruction share**, itself a
  lower bound (fall-through-fused blocks carry no hits).
* **Diablo's dump is incomplete** — 810 hot-block-histogram collisions on 1260
  addresses.
* **Nothing about browser behaviour.** All five runs are the CLI, where ~15% of
  ticks are JS rasterisation that does not exist in the browser.
* **No region was compiled.** There is no measurement here of what a compiled
  region would actually run at; §4.3's 1.4–1.6× is arithmetic from a profile,
  not an observation.
