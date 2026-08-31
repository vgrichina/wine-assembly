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
2. **The cache key used to cost 35 MB.** The first version hashed one
   concatenation of the whole closure, i.e. built an 11 MB temporary string.
   It is now a digest-of-digests (hash each file, hash the list), which cut
   peak RSS from 298/303 MB to 249/265 MB — a ~50 MB win for a five-line
   change, and the only memory work done here.
3. Everything after that is the compiler itself: ~130 MB above the resident
   snapshot at its peak.

**Optimization is explicitly left as future work.** It belongs to whoever owns
the vendored compiler, not to this plumbing.

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
