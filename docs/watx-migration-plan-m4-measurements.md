# Milestone 4 — compiler-Worker measurements

What this answers: the open gate in [`docs/watx-migration-plan.md`](watx-migration-plan.md)
§"Milestone 4 — Browser source compilation" — *"Measure cold compile time and
peak process memory for Wine's 10.23 MB closure"*, against the plan's inherited
sub-100 MB mobile target and its known Android-corpus number of **178.36 MB max
RSS for a 6.81 MB closure**.

Everything below was taken with the plumbing this document accompanies:

| file | role |
|---|---|
| `lib/watx-compile-worker.js` | the disposable Worker. Pure compute: source text in, validated wasm out. Runs in a browser Worker and in node `worker_threads` from the same file. |
| `lib/watx-launcher.js` | host side. `fetchSources()` reads each file exactly once, `compile(mode)` spawns the Worker and **always** terminates it in a `finally`, `cacheKey()` is content-addressed. Not yet wired into `host.js` — the exact wiring diff is in that file's header comment. |
| `test/test-watx-compile-worker.js` | 27 checks; compiles the real closure in both modes inside a Worker. |

**Status: FINAL.** Taken at `c2c54c8e`, with the working tree clean for
`tools/watx-src/` and `src/`, i.e. **after** G8 (`aba5ff7f`, explicit-drop stack
modelling) and G5 (`65961f32`) landed. Nothing is neutralized: the whole
`src/main.watx` closure compiles as committed, in both dispatch modes, with
**zero compiler warnings**.

## 1. What compiles

60 includes, 11.29 MB of source text (10.23 MB is the plan's audited-source
figure for the same closure; the difference is comments and the `main.watx`
manifest itself).

| where | mode | bytes | `WebAssembly.validate` | warnings |
|---|---|---|---|---|
| node `worker_threads` | tail-call | 984,312 | ✅ | 0 |
| node `worker_threads` | compatibility | 984,761 | ✅ | 0 |
| headless Chrome 151, browser Worker | tail-call | 984,312 | ✅ | 0 |
| headless Chrome 151, browser Worker | compatibility | 984,761 | ✅ | 0 |

The two engines produced **the same byte counts**, which is the first evidence
that the browser path is not a different build. (Byte *equality* is not the
acceptance criterion — `tools/watx-matrix.js` owns the decoded-ABI comparison.)

## 2. Node: cold compile time and peak RSS

One fresh `node` process per row, `/usr/bin/time -l` for max RSS (that is the
OS's number for the whole process — `process.memoryUsage()` called inside a
`worker_thread` reports the process too, and only at the boundaries we sample).
Three runs per mode; **the max is the number to quote**.

Box: darwin 23.6.0, node v23.10.0, shared with other agent sessions — `loadavg`
is recorded beside every run because it is routinely 4-13 here.

| mode | run | loadavg (1 min) | compile ms | wall ms | max RSS |
|---|---|---|---|---|---|
| tail-call | 1 | 13.32 | 1466 | 1509 | 242.7 MB |
| tail-call | 2 | 12.42 | 1452 | 1497 | 238.5 MB |
| tail-call | 3 | 12.42 | 1481 | 1524 | **249.1 MB** |
| compatibility | 1 | 12.42 | 1498 | 1546 | 255.9 MB |
| compatibility | 2 | 11.74 | 1520 | 1563 | **264.8 MB** |
| compatibility | 3 | 11.74 | 1462 | 1505 | 239.9 MB |

**Quote: ~1.5 s cold compile, 249 MB (tail) / 265 MB (compat) peak process RSS.**

Time is remarkably load-insensitive: an earlier identical sweep at loadavg 4.4
gave 1477–1492 ms, so the compile is CPU-bound on one thread and not contending
for anything. `evalMs` (loading the four compiler files into the Worker) is
2.6 ms and `validateMs` is 1.7–2.7 ms; **97 % of the wall clock is `compile()`**.
Reading the 11.29 MB of source off local disk is 16 ms.

## 3. Headless Chrome (functional + memory only)

Driven with the repo's usual pattern (`puppeteer` + a local server, as in
`test/test-web-*.js`), served cross-origin-isolated so
`performance.measureUserAgentSpecificMemory()` exists, and launched with
`--enable-precise-memory-info`. Per CLAUDE.md this is a valid use of headless:
pass/fail plus memory readings, **no fps or "how it feels" claims**.

Both modes compiled and validated (table in §1). Memory:

| reading | tail-call | compatibility |
|---|---|---|
| page JS heap before → after the Worker was terminated | 12.1 → 45.5 MB | 12.7 → 45.5 MB |
| `measureUserAgentSpecificMemory()` before → after | 21.3 → 22.3 MB | 21.3 → 22.3 MB |
| whole-Chrome RSS (all processes) baseline → peak during compile | 833 → 1047 MB | 769 → 988 MB |
| whole-Chrome RSS delta across the compile | **+214 MB** | **+219 MB** |

Read these carefully:

- The **page** heap ends ~45 MB because the page is deliberately still holding
  the 11.29 MB fetch-once snapshot plus the 1 MB module. The
  agent-wide `measureUserAgentSpecificMemory()` reading is back to ~22 MB after
  termination, i.e. **the compiler's memory really is released before Wine's
  512 MB shared memory would be allocated** — which is the invariant Milestone 4
  exists to protect.
- The whole-Chrome RSS delta (~215 MB) is the browser-side peak, and it agrees
  with node's ~250 MB. It is a *delta of a whole browser under load* and the
  baseline drifted 769→867 MB across the run, so treat it as ±tens of MB.
- **Chrome exposes no way to read a dedicated Worker's own heap.**
  `performance.memory` is window-only (it read `null` inside the Worker), and
  `measureUserAgentSpecificMemory()` resolves only at a GC, so it cannot sample
  a ~600 ms synchronous compile. That is why the browser peak above is taken
  from the OS instead of from the page.

Curiously the browser compile is *faster* than node's for the same input
(554/481 ms vs ~1470 ms). Not investigated — it is not a gate, and it is the
wrong direction to worry about.

## 4. Where the memory goes

Not an optimization attempt — per the task, just a cheap phase probe, recorded
so a later session does not have to rediscover it. Fresh node process, RSS at
each boundary the launcher already has:

```
0. node started                                rss  37.0 MB
1. + 11.29 MB source snapshot read (parent)    rss  65.7 MB
2. + one structured-clone-sized copy of it     rss 161.5 MB
3. + sha256 over compiler and sources          rss 167.5 MB
4. + worker compile done, worker terminated    rss 212.5 MB
   worker-sampled peak rss during compile      rss 295.6 MB
5. after an explicit global.gc()               rss 190.6 MB
```

Three things are visible without touching the compiler:

1. **The source exists twice by construction.** 11.29 MB of text costs ~29 MB in
   the parent (JS strings are UTF-16, plus per-string overhead), and
   `postMessage` structured-clones it into the Worker, so the snapshot is
   resident on both sides for the whole compile. Line 2 above models that copy
   and it is the single largest step. A future reduction would send the sources
   as one transferable `ArrayBuffer` of UTF-8 bytes and decode per file inside
   the Worker — roughly a 2× saving on the snapshot alone, at the cost of the
   caller no longer being able to reuse the snapshot for the second mode.
   **Done, 2026-08-31 (`49f30eff`) — see §4.1.** The reuse cost turned out to
   be avoidable: ownership decides copy vs move, so both properties hold.
2. **The cache key used to cost 35 MB.** The first version hashed one
   concatenation of the whole closure, i.e. built an 11 MB temporary string.
   It is now a digest-of-digests (hash each file, hash the list), which cut
   peak RSS from 298/303 MB to 249/265 MB — a ~50 MB win for a five-line
   change, and the only memory work done here.
3. Everything after that is the compiler itself: ~130 MB above the resident
   snapshot at its peak.

**Optimization of point 3 is explicitly left as future work.** It belongs to
whoever owns the vendored compiler, not to this plumbing. Points 1 and 2 were
plumbing and are now both done.

### 4.1 The handoff is UTF-8 bytes, transferred (2026-08-31, `49f30eff`)

The snapshot is `Uint8Array`s end to end — read that way (`fs.readFileSync`
with no encoding, `response.arrayBuffer()` rather than `.text()`), hashed that
way, and posted to the Worker as transferable `ArrayBuffer`s, one per file. The
Worker decodes them one at a time and nulls each buffer slot as it goes, so the
compiler's own interface is untouched: it still gets
`compile(entryText, vfsMapOfStrings, options)`.

A transferred buffer is detached in the sender, so **ownership** decides copy
vs move, and `compileDetailed()` knows which case it is in: a *caller-supplied*
snapshot is copied per attempt (it will be compiled again in the other dispatch
mode), a snapshot the launcher read for this one compile — `host.js`'s path —
is transferred as it is. So the "cost" the note above predicted, losing snapshot
reuse, is not paid: both modes still compile from one read, and the browser path
still never allocates the extra copy. Sources are read exactly once per attempt
either way; nothing is re-read to recover a detached buffer.

**The cache key did not move.** It always hashed each file's UTF-8 encoding;
hashing the bytes directly is the same digest with one fewer full copy
materialised, and the test asserts that a text-form snapshot of the same content
still lands on the same key, so any persisted cache survives the change.

Measured on this box, **interleaved** A/B (both arms alternating, order rotated,
one cold compile per process, 4 reps × 2 dispatch modes per arm), whole-process
max RSS from `/usr/bin/time -l`:

| path | before | after | Δ |
|---|---|---|---|
| caller supplies the snapshot (the test's shape) | 253.6 MB | 226.1 MB | **−27.5 MB**, AFTER wins 8/8 |
| launcher reads its own (`host.js` / the browser) | 250.8 MB | 214.6 MB | **−36.2 MB**, AFTER wins 8/8 |

and, per phase, against the table in §4:

```
1. + 11.38 MB source snapshot read (parent)    +29.2 MB  ->  +11.8 MB
2. + sha256 over compiler and sources        +2.7..6.2 MB -> +2.1..2.5 MB
3. after the worker is terminated, i.e. the
   reading immediately before Wine's 512 MB     ~165 MB  ->   ~126 MB
```

Interleaving is not optional here: three consecutive non-interleaved runs of one
arm on this (shared, loaded) box spread 34 MB, wider than the effect. The
sequential first attempt made the compatibility mode look like a *regression*;
alternating the arms turned it into a −27 MB win that holds in every pairing.

**Byte identity.** `build/wine-assembly.wasm` `737ff788…` and
`build/wine-assembly.compat.wasm` `fcc1b675…` are unchanged — `tools/build.sh`
never loads either file — and the compiler Worker's own output hashes to those
same two digests, in node and in headless Chrome through `?compile-wat`, where
Solitaire launched from the in-browser-compiled module and reached its message
loop with a clean page log.

## 5. What is still unmeasurable here, and what the gate says

- **Real iOS Safari on a device: not measured, cannot be measured from this
  box.** It is hardware. `tools/ios-selftest-server.js` + `tools/ios-eval.js`
  are the mechanism (serve the repo on the LAN, open it on the phone, evaluate
  an expression remotely) and a page equivalent to the scratchpad probe would
  run there, but Safari exposes *no* memory API at all — not
  `performance.memory`, not `measureUserAgentSpecificMemory()` — so even on the
  device the answer would be "did it complete", not "how much did it use".
  The practical iOS gate is therefore a **pass/fail**: does a source compile of
  the full closure complete on a real iPhone without the tab being reaped, and
  does Wine's 512 MB allocation still succeed immediately afterwards.
- **The plan's sub-100 MB mobile question stays OPEN.** The desktop peak does
  *not* land under 100 MB: 249 MB (tail) / 265 MB (compat) in node, ~215 MB
  delta in Chrome, against the plan's 178 MB Android number for a closure two
  thirds this size. Scaling that Android figure by source size predicts ~268 MB,
  which is what we measured — so this is the expected number, not a regression,
  and it is roughly 2.5× the target.
- What Milestone 4's exit gate *can* already be signed off on from here:
  artifact-first launch is untouched, a forced source compile passes in Chromium
  in both dispatch modes, and **compiler memory is demonstrably released before
  Wine memory is allocated** (§3, the 45 MB → 22 MB agent reading after
  termination). The Safari/iOS half of the gate is not.

  **Update 2026-08-31 — desktop Safari is now green.** Real Safari 26.4
  (WebKit 605.1.15) compiled the same closure in a real browser `Worker`, both
  modes, and the artifacts both validate *and* instantiate: 983,990 B tail
  (566 ms) and 984,439 B compat (540 ms), zero warnings, byte counts identical
  to node's in the same worktree. Details, plus why `jsc` is not admissible
  evidence about Safari and why `safaridriver` was not used, are in
  `docs/watx-migration-plan.md` §"Milestone 4". Safari still exposes no memory
  API, so this is a pass/fail, exactly as predicted above, and the **iOS device**
  half remains unmeasured.

## 6. Reproducing

```bash
# the plumbing test (both modes, in a real Worker, 27 checks)
timeout -s KILL 300 node test/test-watx-compile-worker.js

# node cold-compile + peak RSS, one mode per process
/usr/bin/time -l node -e "require('./lib/watx-launcher.js')
  .compileDetailed({tailCalls:true},{noMemo:true,timeoutMs:280000})
  .then(r=>console.log(r.byteLength, r.valid, r.timing))"
```

The headless-Chrome probe was a scratchpad page (a `<script src=lib/watx-launcher.js>`
plus a `window.M4.run(tailCalls)` entry point) driven by a puppeteer script that
polls `ps` for whole-browser RSS across the compile window. It is not committed:
it is a measurement jig, and once `host.js` is wired (see the launcher header)
the same reading is available from the real page with `?compile-wat`.

## 6. Follow-ups (2026-08-31, session `watx-perf`)

Two questions the sections above left open, measured on artifacts **pinned** at
`8bd1cd39` (`build/wine-assembly.wasm` 986,139 B and `build/wine-assembly.compat.wasm`
986,588 B copied out of `build/` before any work started, because the working
tree was moving under three other agents). Box: darwin 23.6.0, node v23.10.0,
loadavg 3.5–6 throughout, which is why **every whole-app number below is user
CPU over fixed work, not wall clock**.

### 6.1 What does `wasm-opt` do to our artifact?

Never measured before: the WATX backend is a direct emitter with no optimization
passes at all, so this is the first reading of how much a real optimizer finds.
`wasm-opt` version 121 (`/opt/homebrew/bin/wasm-opt`), run with `--all-features`.

| artifact | baseline | `-O2` | `-Os` |
|---|---|---|---|
| tail-call | 986,139 B | 851,793 B (**−13.6 %**) | 823,291 B (**−16.5 %**) |
| compatibility | 986,588 B | 851,818 B (−13.7 %) | 823,322 B (−16.6 %) |

**Correctness: all four optimized artifacts are functionally identical on the
smoke.** `WINE_ASSEMBLY_WASM=<artifact> node test/run.js --app=sol --quiet-api
--no-build --max-batches=2000 --no-close --png=…` gives the **same sha256 PNG**
(`563aa73e…`) and the same `6517 API calls` for all six of {base, −O2, −Os} ×
{tail, compat}; `tools/png-diff.js` reports 0 of 307200 pixels differing.

**No exotic features are introduced.** `--all-features` is only what `wasm-opt`
will *accept*; re-validating each output under the narrow set the module actually
uses (`threads, bulk-memory, simd, sign-ext, tail-call, mutable-globals,
nontrapping-float-to-int, multivalue, reference-types`) passes for all four. So a
`-O2` artifact is shippable to the same engines as the baseline.

**Throughput: nothing, within noise.** Fixed work = `--app=caesar3_demo
--quiet-api --no-build --max-batches=36000` (~12 s user, chosen because Caesar's
cost per batch is wildly non-linear — 28k batches is 2.6 s user and 40k is 54 s,
so a batch count is only comparable against itself). Three reps per arm,
interleaved:

| arm | user CPU (3 reps) | min |
|---|---|---|
| baseline tail | 13.30 / 11.71 / 11.32 s | 11.32 s |
| `-O2` tail | 13.33 / 11.51 / 11.59 s | 11.51 s |

That is 0 to −2 % either way — i.e. **`wasm-opt` does not measurably speed up the
interpreter.** Which is the expected result and worth writing down: the hot loop
is `$next` plus a table dispatch, and its cost is engine dispatch overhead, not
anything a wasm-level optimizer can fold.

**There is a real startup regression.** Same command at `--max-batches=1`
(process + instantiate + PE load + boot), four reps interleaved:

| arm | user CPU |
|---|---|
| baseline tail | 0.10 / 0.11 / 0.10 / 0.11 s |
| `-O2` tail | 0.33 / 0.30 / 0.30 / 0.42 s |
| `-Os` tail | 0.34 / 0.28 / 0.29 / 0.36 s |

**+0.2 s of user CPU per instantiate, consistently, 3×.** It is *not* module
decode: `WebAssembly.compile()` of the raw bytes is 2.0–2.2 ms for every one of
the six artifacts, optimized or not (the smaller files are marginally faster).
So the cost is on the lazy-baseline-compile path — `wasm-opt` inlines and merges,
the resulting functions are bigger, and the boot path pays more to tier them in.
This matters more than it looks under `--threads`, where every worker instantiates
the same module.

**Cost to run it:** `-O2` is ~10 s and `-Os` ~12.5 s of *user* CPU per artifact,
and the build emits two artifacts — so wiring it into `tools/build.sh`
unconditionally would add ~20–25 s of CPU to a build every agent runs constantly.

**Verdict: worth having as an opt-in ship step, not as part of the build.** It
buys 135–163 KB off the wire (−14 % / −17 %, and gzip will shrink the gap
further), costs nothing in correctness, buys nothing in throughput, and costs
0.2 s of startup CPU per instance plus ~22 s of build CPU. That trade is right
for `tools/deploy-berrry.js` and wrong for `bash tools/build.sh`. Nobody should
wire it in without re-checking the startup number, because it is the one thing
that got *worse*.

### 6.2 The node-vs-browser 3× in §3 — investigated, not explained by anything we control

§3 recorded that the same closure compiles in ~1470 ms in node and 554/481 ms in
a Chrome Worker, and left it. Five experiments, cheapest first. **Four are clean
negatives, and the fifth is not actionable.**

Baseline reproduction on the current tree, compiling the real closure
in-process through `tools/watx-closure.js` (the same entry `tools/build-compile-wat.js`
uses): snapshot read 19–21 ms, compile 1970–2110 ms per mode. Larger than §3's
1470 ms because `src/` has grown since `c2c54c8e`, not because of the harness.

1. **JIT warm-up — REFUTED.** Six consecutive compiles in one process,
   alternating modes: 2109 / 2094 / 2034 / 2057 / 2033 / 1970 ms. The sixth
   compile is 6 % faster than the first. There is no 3× warm-up cliff, so the
   browser number is not "node's second compile".
2. **`--no-lazy`, `--max-old-space-size=8192` — no reproducible effect** once
   read as user CPU rather than the wall clock this box cannot hold still.
3. **GC — not the cost.** `--max-semi-space-size=64/128` did not help, and a CPU
   profile puts `(garbage collector)` at **1.7 %** of a 1929 ms compile.
4. **Maglev — already on.** `node --v8-options` reports `--maglev` default *on*
   in node 23; passing it explicitly changes nothing.
5. **Engine version — the standing explanation, and we cannot flag our way out
   of it.** node v23.10.0 is **V8 12.9**; the Chrome on this box is **152**
   (V8 ~14.x). That is the only difference left after the four negatives above,
   and §1's byte-count equality already rules out "the browser compiled something
   smaller". Nothing in `build.sh` can close it; a newer node would.

**No pathology to fix.** Self time over one compile is ordinary, spread work:

```
 514 ms  26.7%  compileExpr        compiler-codegen.js:2020
 333 ms  17.3%  parseSource        compiler-parser.js:230
 152 ms   7.9%  recycleWatxTree    compiler-parser.js:315
 151 ms   7.8%  expandForm         compiler-stages.js:100
 150 ms   7.8%  walk               compiler-codegen.js:4048
  68 ms   3.5%  scanWatxFunctionHeader
  33 ms   1.7%  (garbage collector)
```

**`build.sh` already does the obvious thing.** `compileWatx()` in
`tools/build-compile-wat.js` calls `compileClosure()` twice — tail-call then
compatibility — **in one process**, over one `watxSourceClosure()` snapshot. There
is no per-mode spawn to eliminate and no second disk read; the 19 ms snapshot is
read once. So the "compile both modes in one process" idea is already the shipped
behaviour, and there is nothing to commit here.

**The one real lead, left un-taken deliberately.** The two modes re-parse the
same 11.29 MB from scratch: parse and scan (`parseSource` + `recycleWatxTree` +
`scanWatx*`) are **~33 %** of a compile, and compile #2 in the profile above costs
the same as compile #1, so none of it is reused. Caching the parsed tree across
the two dispatch modes would cut a build's compile phase from ~4.0 s to ~3.35 s
(−16 %) — worth having, but it is a change inside `tools/watx-src/compiler-*.js`,
which was claimed by another agent while this was measured, and a parse cache
shared between two modes is exactly the kind of change that needs the
byte-identity gate run against it rather than a drive-by commit.
