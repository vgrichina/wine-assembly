# Replicated dispatch (`repl_tailcall`) for the main emulator

**Status:** proposal, not started. Nobody owns this yet — claim it on
`messageboard.txt` before touching `src/*.wat` or `lib/compile-wat.js`.

**Where the number comes from:** [toyvm-dispatch-shootout.md](toyvm-dispatch-shootout.md).
That work compared four interpreter dispatch shells in the toy VM
(`tools/toyvm/`), on real DOS demos rather than a synthetic loop. This document
is the argument for carrying one of its four results across into the main
wine-assembly emulator, and the list of ways that carry could fail.

---

## 1. The main emulator is already the shootout's baseline arm

This is the fact that makes the result transferable rather than merely
suggestive. The shootout's `tailcall` arm is: *one shared `$next`, one
`return_call_indirect` site, every handler ends by tail-calling `$next`.*

The main emulator is exactly that construction:

- `src/04-cache.wat:936` — the single dispatch site,
  `(return_call_indirect (type $handler_t) (local.get $op) (local.get $fn))`
- **406** handlers end in `(return_call $next)`, spread over eight files:

  | file | sites |
  |---|---:|
  | `src/05-alu.wat` | 276 |
  | `src/06b-core-handlers.wat` | 71 |
  | `src/05b-string-ops.wat` | 18 |
  | `src/06c-mmx.wat` | 18 |
  | `src/05c-seg16-ops.wat` | 16 |
  | `src/06-fpu.wat` | 4 |
  | `src/07b-loop-match.wat` | 2 |
  | `src/04-cache.wat` | 1 |

- `(table $handlers 443 funcref)` in `src/02-thread-table.wat`

So the two systems differ in ISA, handler count and handler size, but not in
dispatch shape. The shootout's other three arms (`calls`, `switch`,
`repl_tailcall`) are all describable as edits to this one.

## 2. What `repl_tailcall` is

Give every handler its own copy of the dispatch tail instead of tail-calling
one shared `$next`. Nothing else changes: same handler bodies, same table, same
threaded-code format, same `$steps` accounting.

```
  tailcall                            repl_tailcall
  --------                            -------------
  $th_add_r_i32:                      $th_add_r_i32:
     ...body...                          ...body...
     return_call $next                   steps--; if (<=0) { resume_ip=ip; return }
                                         fn = [ip]; op = [ip+4]; ip += 8
  $next:                                 return_call_indirect fn(op)
     steps--; ...
     fn = [ip]; op = [ip+4]; ip += 8   $th_sub_r_i32:
     return_call_indirect fn(op)          ...body...
                                         steps--; if (<=0) { resume_ip=ip; return }
                                         fn = [ip]; op = [ip+4]; ip += 8
                                         return_call_indirect fn(op)
```

**Why it is supposed to be faster.** One shared dispatch site gives the CPU's
indirect-branch predictor a single history slot for every opcode transition in
the program. Replicating it gives each *predecessor* opcode its own slot, and in
a real instruction stream the next opcode correlates strongly with the current
one — `push` follows `push`, a compare is followed by a jcc. The shared site
throws that correlation away.

**Measured in the toy VM:** geomean **+10.6%** over ten DOS programs, ahead on
**10 of 10**; and **+10.5%** over the 50 programs of a 94-program sweep that run
at least 1M dispatches, with the pixels/no-pixels split at +11.3% / +10.0%.
Three independent sweeps gave +9.7%, +9.9%, +10.5%. It is the most stable result
in that document — and the one shell the earlier synthetic microbenchmark never
tested.

## 3. Why the transformation is sound here

A handler is already entered by tail call, so replacing its
`(return_call $next)` with a copy of `$next`'s body preserves both exits
exactly:

- **The `$steps` escape.** `$next` sets `$resume_ip` and `return`s. Because the
  handler was tail-called, its frame *is* the frame `$next` would have had, so
  the `return` lands in the same place — `$run`, which reads `$resume_ip` and
  resumes the block mid-stream (`src/13-exports.wat`, the `$resume_ip` branch).
- **`$ip` at the point of inlining.** `$next` snapshots `$resume_ip` from `$ip`
  *before* loading the next `fn`/`op`. At a handler's tail, `$ip` has already
  been advanced past that handler's own operand words, so the snapshot names the
  next op either way. Unchanged.

`$next` itself must stay: `$run` calls it directly (non-tail) on the resume
path, and that call is what makes the whole chain return into `$run`.

## 4. A second, independent reason to expect a win

V8's wasm inlining budget already refuses to inline `$next` (and `$g2w`,
`$get_reg`) at the hottest call sites — measured at roughly 8% of CPU, with
`--wasm-inlining-min-budget` as the thermometer. See the
`project_v8_wasm_inlining_budget` note.

Replication is exactly that inlining, performed in the source where the engine's
growth-factor budget cannot decline it. The two arguments are independent — one
is about the branch predictor, one is about the compiler's budget — and they
point the same way.

## 5. What could go wrong, and why it must be measured rather than assumed

**`$next` is much fatter here than in the toy VM.** The main emulator's version
carries, in this order:

1. the `$steps` decrement and the `$resume_ip` escape,
2. a `$fn >= 443` bounds check with a cache-recovery path
   (`0xCAC4BAD0` log, `$clear_cache`, return),
3. a `$handler_hist_enabled` branch,
4. the load/advance/`return_call_indirect`.

Replicating all four 406 times trades branch-predictor pressure for instruction
cache pressure — the opposite direction from the thing being bought. The toy
VM's `$next` is a fraction of this, so its +10.6% was measured on a thinner
tail than a naive port would produce.

**Code growth is not monotonic, and the same document proves it.** `switch`, the
other code-growth arm, is bimodal: **+40.1%** on DSTNFO and **−26.0%** on
COPPER, reproduced across two runs at different box loads. What code growth
costs depends on whether *that program's* hot handlers still fit the engine's
budgets, which is a per-program property. Do not assume a single sign.

**+10.6% is ns/dispatch, not end-to-end.** For calibration, the
`return_call_indirect` change itself measured −22% on Caesar III, −15% on
Diablo, −11% on Liquid War and about −2% on StarCraft — the last is host/GDI
bound, not interpreter bound. Expect materially less than 10% on a real app,
and expect it to vary by app.

**Size.** ~406 copies of a thin tail is on the order of 20 KB against a 977 KB
module — about 2%, which matters for browser load time but not much. A fat tail
replicated 406 times is a different conversation; see the staging plan.

## 6. Suggested plan

**Do not hand-edit 406 sites.** Make it a source transform in the WAT pipeline —
`lib/compile-wat.js` or `tools/concat-wat.js` — that rewrites
`(return_call $next)` into the inlined sequence. One build switch, trivially
A/B-able, and it keeps the 406 handler definitions readable. A hand-applied
version is unmaintainable and un-revertable.

Staged, cheapest experiment first:

1. **Replicate the thin tail only.** Inline the `$steps` escape, the
   load/advance and the `return_call_indirect`. Leave the bounds-check recovery
   and the histogram branch behind `$next` (or behind a build flag), so the
   replicated tail resembles the shape the +10.6% was measured on.
2. **Top-N before all-406.** Take the hot handler list from `--handler-hist` and
   replicate only those. That captures most of the predictor benefit at almost
   no icache cost. If the partial build wins and the full build does not, that
   difference *is* the answer about which of the two effects dominates — which a
   single all-or-nothing build cannot tell you.
3. **Then all 406**, only if the partial build is positive.

## 7. How to measure it

Use the protocol that cleared the `return_call_indirect` change, not a fresh
one:

- **Fixed work, user CPU.** `--max-batches` plus user CPU time — *not*
  `--max-seconds` and batches/s. Under box load, a fixed-duration run cannot
  resolve a single-digit percentage. See the `feedback_fixed_work_cpu_time` note.
- **Interleaved arms, rotated starting arm, minimum of N.** Within-arm
  min-to-max ran 6–63% in the shootout runs — routinely wider than the gap
  between two arms. A sequential arm-then-arm layout produces a confident number
  for whichever arm happened to run during a quiet minute.
- **Check `uptime` first and quote it.** This box regularly sits at load 20–40
  with other agent sessions running sweeps. Never quote a timing taken there.
- **Several apps, and say which.** At minimum one interpreter-bound
  (`caesar3_demo`), one mixed (`diablo_demo`), one host-bound
  (`starcraft_shareware`), because the expected result differs by kind.
- **30 s cap per benchmark.** Re-scope the measurement rather than raising the
  timeout.

Correctness gate — the same one the tail-call change passed:

- byte-identical API traces and **0-pixel** `tools/png-diff.js` results across
  sol, wordpad, mspaint, explorer98, pinball, tworld, calc;
- `--handler-hist-thread=N` op counts identical between arms (this transform
  must not change the work done — if op counts move, something is wrong, and
  equal op counts still do **not** prove the new build is faster; see
  `project_next_dispatch_negative`);
- the build's own gates, including the handler-count check.

## 8. What this does not affect

The no-tail-call fallback build (iOS Safari, and any engine without the tail
call proposal) lowers `return_call` to `call; return`. Today that costs two
nested frames per dispatch — the handler's and `$next`'s. Replication makes it
one. That build gets shallower, not deeper, so this is not a blocker there.

---

## Related

- [toyvm-dispatch-shootout.md](toyvm-dispatch-shootout.md) — the measurement,
  the other three shells, and the corpus caveats
- [interpreter-dispatch-perf.md](interpreter-dispatch-perf.md) — the main
  emulator's own dispatch history, including the `return_call_indirect` result
- [toyvm-trace-jit.md](toyvm-trace-jit.md) — the other direction (compiling a
  trace instead of dispatching it), and why its 2.10× per trace is only 1.22×
  per program
