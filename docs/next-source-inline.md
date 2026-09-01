# Writing `$next` out at its 405 call sites — a measured negative

Measured 2026-09-01 on `main` (working tree at `ad5d5391` plus other lanes'
in-flight edits; both A/B artifacts built from the *same* tree, so nothing but
this transform differs between them). **Verdict: source-inlining the dispatch
step is 3-4% SLOWER than calling it on a dispatch-dense app (Heroes II), in two
independent interleaved runs, with and without the defensive guard, and exactly
neutral (−0.1%) on a super-op-dense one (Caesar III). It is never faster. Do not
land it.** This is the follow-on the
[accessor fast-path null](accessor-fastpath-split.md) pointed at — "that is a
register/dispatch-shape problem … and it is where the next attempt at this lever
should go" — and it closes the dispatch half of that sentence.

Read [interpreter-dispatch-perf.md](interpreter-dispatch-perf.md) first; this
memo extends its table rather than replacing anything in it.

## What the evidence said before any WAT was written

`node --trace-wasm-inlining test/run.js --app=heroes2_demo --max-batches=40000`
+ `tools/inline-verdicts.js`, at HEAD. The ranking the accessor memo left behind
still holds, and `$next` is still the single largest refusal:

| callee | wire size | calls at denied sites | calls at inlined sites |
|---|---|---|---|
| `$next` | 85 B | 3,001,637 | 211,254 |
| `$get_reg` | 69 B | 1,525,300 | 834,399 |
| `$gs32` | 117 B | 1,403,789 | 28,826 |
| `$gl32` | 104 B | 1,387,640 | 119,693 |
| `$set_reg` | 85 B | 1,250,226 | 74,514 |
| `$g2w` | 360 B | 833,028 | 478,038 |

**Every `$next` refusal reads `not enough inlining budget`**, at a caller graph
size of 32-120 — e.g. `{index=356, count=72222, size=85} graphsize=39: not
enough inlining budget`. V8 computes a per-caller budget of
`max(--wasm-inlining-min-budget (50), --wasm-inlining-factor × caller graph
size)` and compares `current_graph_size + callee wire size` against it. Handlers
are tiny, so their budget is the floor, and 85 bytes never fits. Handlers that
are *not* tiny do get it: `$branch_end` (graph size 104) inlines `$next`
happily.

### The thermometer, re-measured, and the horizon it needs

`--wasm-inlining-min-budget=600` lifts the floor above every callee in the
table. Interleaved, order rotated per rep, user CPU on fixed work:

| workload | stock | budget 600 |
|---|---|---|
| heroes2, **120000** batches, 3 reps | med 12.73 | med 13.16 (**+3.4%**) |
| heroes2, **300000** batches, 4 reps | med 28.74 `[29.32 28.77 28.74 27.10]` | med 25.96 `[26.29 25.96 27.08 24.68]` (**−9.7%**) |

**The short run does not show the win at all.** Raising the budget raises
compile time, and at 120000 batches compilation is a large enough share to eat
it. Anything measured on this lever must be measured at 300000 batches or more,
or it will report a null that is an artifact of the horizon. (A first sweep at
120000 batches over budgets 50/70/90/120/400/600 appeared to show a smooth
−4%→−14% ramp; re-run with more reps it collapsed to noise, and the b90 arm's
inlining verdict table is byte-for-byte the stock one — a reminder that a
*verdict table* is the cheap way to falsify a timing result.)

So the prize is real and it is ~10%, and by the size-resolved verdict tables it
is spread across `$next`, `$get_reg`, `$set_reg`, `$gl32`, `$gs32` — at budget
400 `$next` flips from 3.00M denied / 0.21M inlined to **0.22M denied / 3.30M
inlined**, and `$get_reg`/`$set_reg` flip with it.

## The transform

No browser ships that flag, so the portable form is to do the inlining in the
source. WATX has `defmacro`, so this needs no compiler change: a `(defmacro
(NEXT) …)` at the end of `src/04-cache.wat` holding `$next`'s body, and
`(return_call $next)` → `(NEXT)` at its **405 tail-call sites** across
`05-alu` (276), `06b-core-handlers` (71), `05b-string-ops` (18), `06c-mmx` (18),
`05c-seg16-ops` (16), `06-fpu` (4) and `07b-loop-match` (2). The three *non*-tail
`call $next` sites (two in `13-exports.wat`'s `$run`, one in `05-alu.wat`) keep
calling the function, because the macro's step-exhaustion path is a `(return)`
and that is only equivalent in tail position.

The body is deliberately **local-free** — a macro cannot declare locals, and
adding two to 405 handlers would be a far larger and more fragile edit. `$ip` is
advanced first and the two thread words re-read at `$ip-8` / `$ip-4`.

Two variants were built and measured, because the first one carries a cost the
function form does not:

* **`inline`** — faithful copy of `$next`, including the `fn >= 443` guard. The
  guard needs the handler index a second time and there is no local to hold it,
  so it costs **one extra `i32.load` per dispatch**. Module 997,816 →
  **1,034,869 bytes (+3.7%)**.
* **`inline2`** — same, guard dropped (kept in `$next` itself). Now exactly
  `$next`'s two loads, plus two register `i32.sub`s. Module **1,025,870 bytes
  (+2.8%)**. Dropping that guard was independently measured at *zero* in
  [interpreter-dispatch-perf.md](interpreter-dispatch-perf.md) §"The two
  rejected generic changes", so this arm is a clean read on the inlining alone.

## And both are slower

`test/run.js --no-build --wasm=…` against the two prebuilt artifacts, 4 reps,
interleaved with the order rotated each rep, user CPU (wall clock is
inadmissible here — the box sat at load 3-6 with other agent lanes running).
Medians and minima agree in both runs:

| run | base | inlined |
|---|---|---|
| `inline` (with guard) | med **26.03** `[31.80 29.04 26.03 25.78]` | med **26.79** `[32.99 35.42 26.79 26.75]` — **+2.9%** |
| `inline2` (no guard) | med **24.72** `[26.81 24.72 25.24 23.99]` | med **25.77** `[25.77 24.98 27.55 26.10]` — **+4.2%** |

Minima: 25.78 → 26.75 (+3.8%) and 23.99 → 24.98 (+4.1%). Removing the extra load
did not recover the loss; it is not the load.

### The second app: a null, and why that is consistent

The same interleaved runner, Caesar III at 40000 batches (past the title-screen
cliff — 25000 batches is 2.3s of user CPU and 357 API calls, i.e. title only),
3 reps, both artifacts built from the *same* current-HEAD tree:

| arm | median user CPU | reps | vs `base` |
|---|---|---|---|
| `base` (no macro, 0 sites) | **54.02** | 54.02, 52.62, 54.50 | — |
| `inline405` (macro + all 405 sites) | **53.95** | 53.95, 53.75, 54.45 | **−0.1%** |

That is inside the noise floor: nothing. The two apps do not disagree — they
bracket the same conclusion. Heroes II is dispatch-dense, so replicating the
dispatch site costs it ~4%. Caesar III at this horizon runs mostly inside folded
loop super-ops (`RLE_RUN`, `rect_run` — see
[caesar fold notes](loop-idiom-superops-design.md)), where one dispatch covers a
whole run of guest work, so the dispatch *shape* barely reaches the total and
the change is invisible. **The transform is between "no effect" and "4% worse"
depending only on how much of an app's time is spent dispatching.** There is no
workload here where it is faster.

Behaviour is unchanged — `tools/png-diff.js` reports **0 differing pixels** for
notepad (4000 batches), sol (6000), Heroes II (40000) and Caesar III (40000)
between the two artifacts.

## Why — and what it rules out

`(return_call $next)` is **already a tail call**, so there was never a frame to
elide; that half was measured at zero in 2026-08 and is measured at zero again
here. What source-inlining actually changes is that the interpreter's ONE
`call_indirect` site becomes **405 of them**. That is the classic threaded-code
replication trick, done for branch prediction — and on V8 it loses:

* a wasm `call_indirect` is not a bare indirect jump. It is a table bounds
  check, a signature compare and a call, so 405 copies of it are ~3% more module
  and 405 cold i-cache footprints instead of one permanently hot one;
* the single shared site's indirect-branch-predictor entry is trained by every
  dispatch in the program. Split 405 ways, each entry sees a fraction of the
  traffic.

So this is a third entry in the same column as the two 2026-08 rejects: **you
cannot make a dispatch cheaper.** Replicating the dispatch site is now measured
as *worse*, not merely neutral.

### The thermometer half-collapsed — and the transform still lost

This is the reading that makes the result more than "a change that did not
help". Four arms, one interleaved run, 3 reps, order rotated, heroes2 300000
batches:

| arm | median user CPU | reps | vs `base` |
|---|---|---|---|
| `base` | **23.86** | 26.30, 23.77, 23.86 | — |
| `base` + `min-budget=600` | **21.35** | 21.90, 21.35, 20.53 | **−10.5%** |
| `inline2` | **24.91** | 24.91, 25.11, 24.06 | **+4.4%** |
| `inline2` + `min-budget=600` | **23.26** | 23.61, 23.26, 23.20 | −2.5% |

Read down the two stock→flag pairs: the flag is worth **−10.5%** on `base` and
only **−6.6%** on `inline2`. Unlike the accessor split — where the thermometer
did not move at all and that was the proof nothing had been captured — here the
transform genuinely *did* capture about a third of the budget's win. It simply
paid more than it captured, and it paid it in both directions: `inline2+b600`
(23.26) is **9% worse** than `base+b600` (21.35), which is the best arm on the
board.

**The engine can have this both ways and the source cannot.** V8 inlines in
TurboFan only, so `base` gets a small shared `$next` in Liftoff and an inlined
one in optimised code. Writing it out in the source pays the +2.8% module and
405 duplicated dispatch sites in *every* tier and in compile time, and collects
the benefit in one. There is no source-level spelling of "inline this only where
it is hot and only after tier-up".

## What is still open

The ~10% the budget flag buys is real, and this memo removes `$next` from the
list of ways to get it. What it does **not** touch:

* `$get_reg` / `$set_reg` (1.53M + 1.25M calls at denied sites). Their 69/85
  wire bytes are an 8-arm `br_table` over eight wasm globals, and there is no
  shrinking that shape while the registers *are* globals — wasm has no indexed
  global access. The register file already exists in linear memory on branch
  `perf/reg-file-in-memory` (see interpreter-dispatch-perf.md §"register file in
  linear memory"), built, execution-identical, and never timed. That is the
  measurement to take next, and it is a 14,600-site change, so it is a lane of
  its own.
* Whether the flag's win is any single callee at all. Both attempts so far
  (accessors, `$next`) captured their target's verdict table completely and
  bought nothing, which is weak evidence that the ~10% is a *sum* over many
  callees plus V8's transitive inlining, and therefore may have no portable
  single-function form.

## It briefly shipped, partially, and was reverted

Worth recording because the failure mode is a shared-worktree hazard, not
anyone's mistake. While this experiment was in flight, another lane committing
`src/04-cache.wat` and `src/06b-core-handlers.wat` picked up the working-tree
versions of those two files — `git commit -- <path>` takes the whole file — so
`75a404c8`/`468b1afa` landed **the `defmacro` plus 71 of the 405 call sites**,
and nothing else. Two things were wrong with that state:

* it is 17% of a transform measured at **+4.2%**, so it is a small regression
  that no A/B on this box could ever resolve on its own (17% of 4.2% is 0.7%,
  well under the noise floor); and
* the version that landed was the **guard-free** `inline2` macro. Those 71
  handlers dispatched with no `fn >= 443` → `$dispatch_bad` arm, so thread-cache
  corruption reached through them **trapped** instead of clearing the cache and
  restarting at `$eip`, while the same corruption reached through the other 334
  handlers still recovered. Nobody chose that asymmetry.

Reverted here: `(NEXT)` → `(return_call $next)` at all 71 sites and the
`defmacro` removed. The revert is pixel-identical to the state it replaced
(notepad, sol, Heroes II, Caesar III), so the guard is restored at no behavioural
cost — the guard only fires on corruption that no test produces.

## Reproducing

Nothing from this lane is in the tree. The transform is two pieces:

1. `(defmacro (NEXT) …)` at the end of `src/04-cache.wat`, holding `$next`'s
   body with `$ip` advanced before the two `$ip-8`/`$ip-4` reads;
2. `(return_call $next)` → `(NEXT)` in `src/05-alu.wat`,
   `src/05b-string-ops.wat`, `src/05c-seg16-ops.wat`, `src/06-fpu.wat`,
   `src/06b-core-handlers.wat`, `src/06c-mmx.wat`, `src/07b-loop-match.wat` —
   a pure text substitution, and exactly reversible, which is what let both A/B
   artifacts be built from one tree with nothing else moving.

One build note worth carrying: `src/00-regions.wat`'s `(owner "file:line")`
clauses point *into* `src/04-cache.wat`, so a block inserted anywhere above them
shifts every one and fails `tools/check-region-decls.js --check-owners`.
Appending at end-of-file costs no owner line, and `defmacro` is collected from
the whole top-level form list before expansion, so placement is free.
