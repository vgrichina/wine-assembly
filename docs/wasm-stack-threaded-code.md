# Wasm Stack-Threaded Code Proposal

ASCII TLDR:

```text
Do not pivot to dynamic Wasm generation for AoE performance work.
Do explore a stack-shaped threaded target as a block-local compiler backend.
The useful version is not "one Wasm-stack value across each existing handler".
Wasm values cannot survive the current call_indirect handler boundary.
The useful version is a static stack-block/threaded-packet handler that keeps
values in Wasm locals inside one handler invocation, then flushes at exits.
Expected wins overlap the current block-local plan: fewer register global
writes, fewer flag materializations, better EA/g2w reuse, and possibly lower
dispatch. The risk is that it becomes a second interpreter with harder side
exits, profiling, and debug behavior.
Recommendation: prototype only after the simple block-local IR skeleton exists,
and keep it as an optional lowering for hot clean AoE blocks.
```

## Idea

The current interpreter is threaded code in the Forth/direct-threading sense:
`src/04-cache.wat` emits `[handler_idx, operand]` words with `$te`, writes
extra operands with `$te_raw`, and `$next` loads the handler index and operand
before a `call_indirect`. `src/02-thread-table.wat` defines the handler table.
`src/07-decoder.wat` decodes x86 into that stream.

The stack-threaded idea is to keep that model, but add a compiler target for
hot decoded blocks:

```text
x86 bytes
  -> normalized block IR
  -> local liveness and memory analysis
  -> stack-shaped packet
  -> existing thread arena points at th_stack_block(packet)
  -> th_stack_block executes packet with Wasm locals / top-of-stack cache
```

This is not dynamic Wasm generation. The runtime would not create new Wasm
functions. It would emit threaded code that calls a static WAT handler, for
example `th_stack_block`, with a pointer/length to a compact packet in the
thread arena. That handler would execute a small stack-shaped bytecode or
template language using Wasm locals such as:

```text
tos0, tos1, tos2       cached stack values
v_eax..v_edi           optional virtual register locals
dirty_reg_mask         registers that must be flushed
flag_kind/a/b/res      virtual lazy flags
ea0/wa0                address and translated pointer temporaries
```

The important distinction:

```text
Bad version:
  th_push_virtual leaves a Wasm operand-stack value for th_add_virtual.

This cannot work with current handler threading because each handler is a
separate call_indirect with type (param i32). Wasm validation requires the
callee and caller stacks to match at the call boundary; the next handler cannot
inherit arbitrary operand-stack values.

Useful version:
  th_stack_block keeps temporary values in locals while executing a whole block
  or trace-local packet, then flushes machine state before any side exit.
```

So "Wasm stack targeted" should mean "use a stack-shaped compiler IR that is
friendly to Wasm expression/codegen and a local top-of-stack cache", not "make
the existing per-instruction handlers communicate through the Wasm operand
stack".

## Current Baseline

Current handlers are simple and robust, but most hot operations use global
machine state boundaries:

- `get_reg`/`set_reg` in `src/03-registers.wat` read and write x86 register
  globals.
- Lazy flags are also global: `flag_op`, `flag_a`, `flag_b`, `flag_res`, and
  related helpers.
- Memory helpers call `g2w` through `gl32`/`gs32` and friends. Direct
  image-relative translation is cheap arithmetic, but sparse mappings fall into
  a scan, and stores also call code invalidation.
- SIB and base/index EAs are often represented by a separate
  `$th_compute_ea_sib` into `$ea_temp` followed by a consumer handler.
- `$next` pays handler dispatch for each threaded handler, plus histogram work
  when enabled.

AoE profiling already shows the performance shape:

```text
top handlers include load32_ro, jcc, push_r, compute_ea_sib, load32,
mov_r_r, pop_r, cmp_r_r, store32_ro, alu_r_m32_ro

top pairs include cmp_r_r -> jcc, alu_r_m32_ro -> jcc,
compute_ea_sib -> load32, test_r_r -> jcc, and repeated push/pop/load paths
```

The current docs also show that broad runtime fusions often do not pay:

- `br_table` register helpers regressed in Chrome.
- Broad SIB fused handlers regressed.
- Direct stack load/store handlers were flat to slightly slower.
- Several branch-fusion probes reduced dispatch but did not produce durable
  speedups when they still preserved flags or added generic condition work.
- Adjacent load-pair fusions had real surface but no measured speedup; generic
  direct-window guards were actively slower.

That is why this proposal should be treated as a compiler/backend experiment,
not as another broad hand-fused handler set.

## Comparison

### Versus Current Register/Global Threaded Code

Current threaded handlers expose machine state after almost every x86
instruction. That is correct and easy to debug, but expensive for hot blocks.
A stack-block packet can keep state virtual until a known exit:

```text
current:
  mov edx, edi       -> write global edx
  add edx, ecx       -> write global edx, write lazy flag globals
  dec edx            -> write global edx, write lazy flag globals
  cmp edx,[ebx+8]    -> write lazy flag globals
  jl target          -> read lazy flag globals

stack-block packet:
  v_edx = edi
  v_edx = v_edx + ecx
  v_edx = v_edx - 1
  wa0 = g2w(ebx + 8)
  branch using compare(v_edx, load32(wa0))
  flush edx only on exits where it is live
  skip flag globals when both exits overwrite flags before reading them
```

This targets the opportunities already estimated in
`docs/aoe-performance-optimization.md`:

- About 29.8% of seen full register writes in covered hot blocks are avoidable
  under the toy block-local estimator, about 7.2% of total handler-dispatch
  scale in that profile.
- Flag-dead branch opportunities cover a large fraction of the hot-block
  branch surface.
- Stable same-base memory groups are larger than exact repeated-EA reuse and
  point toward compiler-local page/window checks, not generic `g2w` caching.

The cost is complexity. Current handlers are uniform; a stack packet needs
correct side exits, deopt/fallback rules, and enough instrumentation to explain
what it executed.

### Versus br_table Or Direct Threading

`br_table` or direct-threading changes mostly attack dispatch mechanics. The
AoE notes already tested `br_table` register helpers and found them slower in
Chrome. The likely issue is that dispatch is not the only cost; larger or more
branchy handlers can lose more than they save.

A stack-threaded block may reduce dispatch if a whole block is represented as
one handler invocation:

```text
current:
  N threaded handlers, N calls through $next

stack packet:
  1 outer threaded handler, internal loop/template over packet ops
```

But dispatch reduction should be treated as a secondary win. If the packet is
just a miniature interpreter with one branch per micro-op, it can easily trade
`$next` dispatch for internal packet dispatch and lose. The primary reason to
try it is that one handler invocation can keep locals live across several
guest operations:

- no register global write after every virtual instruction
- no global lazy-flag materialization when flags are local or dead
- no repeated EA/g2w work for stable local memory families
- stack-top values can stay in `tos0`/`tos1` locals instead of memory/globals

### Versus Planned Block-Local/Trace-Local Compiler Work

The existing performance direction is:

```text
x86 decode -> normalized IR -> local analysis -> better threaded words
```

The stack-threaded target fits under that plan. It is not a replacement for the
normalized IR or liveness work. It is one possible backend once a block is
classified as clean enough.

Two backend choices can coexist:

```text
existing threaded backend:
  emits today's handler ids plus selected purpose-built primitives
  lower risk, easier to bisect, good for broad coverage

stack-block backend:
  emits th_stack_block plus a packet for hot clean blocks
  higher risk, better chance of keeping locals/flags/EA live across ops
```

The first implementation should still build the normal block-local compiler
skeleton. The stack target should be selected only for blocks where the
classifier predicts real local savings: multiple full-register writes to
coalesce, flag-dead branch tail, and/or stable same-base memory accesses.

## What It Could Optimize

### Register Global Writes

Current handlers write globals through `set_reg` or direct `global.set`.
Inside a stack packet, decoded registers become virtual values. Writes only
need to hit globals:

- at a normal block exit
- at a taken branch side exit
- before a call, return, thunk, yield, unknown op, exception, or fallback
- before any helper that may observe full machine state

This directly targets the estimator's "avoidable global writes" surface. It
should start with non-ESP 32-bit registers. ESP is special because push/pop,
calls, returns, stack memory addressing, and host callbacks observe it.

### Flag Materialization

Flags are currently lazy but still stored in globals. A stack packet can model
flags as virtual values:

```text
flags = sub32(a, b)
br_l(flags, fall, target)
```

If both exits overwrite flags before reading them, the packet can branch
directly and skip `set_flags_sub`/`set_flags_logic`. If flags may be live, the
packet flushes the lazy flag globals before exit.

This should reuse the conservative flag-dead analysis from the AoE notes. In
particular, `INC`/`DEC` cannot be treated as full flag overwrites because they
preserve CF.

### EA/g2w Reuse

Current base+disp handlers recompute `base + disp` and call `gl32`/`gs32`,
which call `g2w`. SIB often uses `$th_compute_ea_sib` plus a consumer. A
stack packet can keep:

```text
ea_base = esi
ea0 = ea_base + 0x14
wa_page = guarded_page_base(ea_base + min_disp)
load32(wa_page + offset0)
load32(wa_page + offset1)
store32(wa_page + offset2, value)
```

This is not a generic `g2w` cache. The broad page-cache probe regressed because
it added traffic to every translation. The stack/block target can guard only
the hot stable groups selected by the compiler, and fall back to the normal
threaded path if the page/window guard fails.

### Stack-Top Caching

There are two different "stacks" here:

- The x86 guest stack at ESP.
- The compiler's virtual evaluation stack inside the packet handler.

The useful cache is local to `th_stack_block`: `tos0`/`tos1` locals can hold
temporary expression values and maybe recently loaded guest-stack values within
one packet. It must not assume that guest memory at ESP is unchanged across
stores, calls, faults, or side exits.

Stack-heavy blocks are common enough to matter, but they should be delayed
until clean non-ESP 32-bit blocks prove the approach. The current classifier
has a "needs stack/ESP model" bucket for a reason.

### Block-Local Temporaries

This is the strongest fit. Local temporaries let the backend represent:

- virtual registers
- flag producer operands/results
- address calculations
- translated Wasm pointers
- loaded values that are reused before an aliasing store

These are exactly the things the toy block compiler printer already shows.

### Dispatch

A stack packet can reduce outer `$next` dispatch if it covers multiple current
handlers. But that should not be the acceptance metric by itself. Prior probes
show that removing 1-2% dispatch without removing helper/global work is not
enough.

Useful dispatch reduction means:

```text
fewer outer handlers
and fewer global register writes
and fewer flag global writes
and fewer repeated g2w/EA computations
without adding a hot branch per old handler that cancels the win
```

### Memory Mapping Overhead

Direct `g2w` is intentionally cheap for the image-relative window. Sparse
VirtualAlloc mappings and invalid/null sentinel behavior still matter, so a
stack packet cannot bypass `g2w` generally. It can only add guarded fast paths:

- same-page/direct-window group guard for selected base+disp families
- fallback to existing handlers or existing helper path on guard failure
- preserve `invalidate_code_write` behavior on stores
- preserve null sentinel semantics for invalid guest addresses

## Risks And Constraints

### Wasm Stack Values Do Not Cross Handler Calls

The current handler type is `(func (param i32))`, and `$next` uses
`call_indirect`. A handler cannot leave arbitrary Wasm operand-stack values for
the next handler. Any design that depends on that is invalid.

The packet must keep values inside one static WAT function invocation, or it
must store them in an explicit shadow stack. An explicit memory/global shadow
stack would likely lose most of the point.

### Indirect Call Boundaries

Once execution calls out to a normal threaded handler, a host import, a thunk,
or a generic helper that can observe machine state, the packet must flush the
relevant virtual state. This limits how large traces can be.

### Side Exits

Conditional branches, guard failures, memory mapping surprises, self-modifying
code invalidation, and step-budget/yield behavior all need exits that leave
globals consistent with the current interpreter contract.

For a first prototype, side exits should be blunt:

```text
flush all dirty virtual regs
flush flags if live
set eip to the exact exit target
return to the normal run loop
```

After correctness is proven, exits can become more selective.

### Exceptions, Calls, Returns, Unknown Ops

Unknown decode, FPU, string/rep, calls, returns, indirect jumps, thunks, and
API crossings should initially terminate a stack packet. They are not good
first targets because they need precise state and are harder to validate.

### Debug And Profiling Complexity

Today the handler histogram can explain hot handlers and pairs. A stack packet
would collapse many operations into one handler unless it adds internal
counters. That can hide regressions.

The prototype needs packet-level profiling from day one:

- packet entry count by guest EIP
- internal opcode counts
- side-exit reason counts
- dirty register flush counts
- flag flush/skipped counts
- g2w guard hit/fallback counts
- approximate "current handlers replaced" count

Tracing and break/count/watch behavior also needs a policy. The simplest policy
is to disable stack packets whenever heavyweight tracing/debug flags are active.

## Prototype Plan

### Milestone 0: Offline Packet Printer

Extend the existing offline analysis direction, not runtime code first.
Starting points:

- `tools/aoe-block-compiler-printer.js`
- `tools/aoe-block-shape-census.js`
- `tools/aoe-reg-liveness-estimate.js`

Add a mode that prints a stack-packet lowering for selected hot blocks:

```text
packet ops
virtual register inputs
dirty register exits
virtual flag status
EA/g2w groups
guard/fallback points
estimated replaced threaded handlers
```

Measurement:

- top 120 hot AoE block coverage
- predicted register global writes removed
- predicted flag writes skipped
- predicted g2w calls or page translations saved
- packet byte size versus current threaded words

Exit criteria:

- The best blocks have combined savings, not just dispatch reduction.
- The printer can explain at least the known examples like `0x00535e08` and
  the larger combined candidates such as `0x0049d9d1`.

Initial tool:

```sh
node tools/aoe-stack-packet-compiler.js \
  --profile=/private/tmp/aoe-web-profile-hot-blocks-32k.json \
  --top=20 \
  --details=5
```

This is offline only. It accepts a conservative clean 32-bit subset, emits a
stack-packet plan, and reports bailout reasons for blocks that still need the
normal threaded path.

First top-20 result from the 10s hot-block profile:

```text
rows compiled:                14/20
block-entry coverage:         10,843,970 / 66,254,912 = 16.4%
current-dispatch estimate:    37,289,326 = 10.0% vs all handlers
packet op estimate:          156,445,731
register writes saved:         4,407,901 = 28.2% of compiled current reg writes
flag writes skipped:          10,398,327 = 65.9% of compiled flag writes
virtual flag ops skipped:      4,923,677
exact EA reuses:                 706,030
page-window g2w save est:        689,248
```

The packet op count is intentionally not compared directly to threaded
dispatches. Packet ops are compiler/backend micro-ops, not current `$next`
handler calls. The useful signal is whether one eventual packet invocation can
remove global register writes, lazy-flag materialization, and repeated address
work.

Known larger candidate:

```sh
node tools/aoe-stack-packet-compiler.js \
  --profile=/private/tmp/aoe-web-profile-hot-blocks-32k.json \
  --addr=0x0049d9d1
```

```text
current dispatch estimate:    18
packet op estimate:           92
register writes:              11 -> 4
flag writes:                   5 -> 1
virtual flag ops skipped:      4
g2w calls in packet:            9
exact EA reuse:                 1
page-window g2w save est:       5
memory group:                  [esi+disp], 6 accesses, range 0x20
```

This is the kind of block that justifies a packet backend better than the
earlier one-off fusions: it combines register coalescing, flag reduction, and
same-base memory grouping in one place.

### Milestone 1: Static WAT Packet Interpreter, Disabled By Default

Add one static handler conceptually like `th_stack_block`, but keep it behind a
feature flag. It reads a packet from the thread arena and executes only a tiny
clean subset:

- 32-bit non-ESP register moves and ALU
- 32-bit base+disp loads
- cmp/test plus signed or equality Jcc
- no calls, returns, FPU, string/rep, partial-width writes, or ESP mutation

This milestone should optimize for correctness and instrumentation, not speed.
Every packet must be able to fall back to current threaded emission.

Measurement:

- packet execution count
- side-exit count/reasons
- comparison against current handler count for the same blocks
- correctness smoke through AoE startup/gameplay

Exit criteria:

- AoE reaches the same gameplay scenario with packets enabled for a tiny
  allowlist.
- No unexplained divergence under a register/flag comparison mode.

### Milestone 2: Local State Wins

Make the packet actually keep locals live:

- virtualize non-ESP 32-bit registers
- flush dirty registers once at exits
- keep virtual flags local
- skip flag materialization for proven flag-dead branch exits
- preserve current lazy flag globals when flags are live

Measurement:

```sh
LABEL=stackpkt-local RUNS=3 HANDLER_HIST=0 node tools/profile-aoe-repeat.js
```

Also collect one hist-enabled run for packet counters.

Exit criteria:

- No-hist AoE repeat mean improves beyond browser noise. A reasonable initial
  bar is at least 2% guest/interpreter improvement on the 10s scenario, or a
  smaller win that is accompanied by clear counters showing the expected
  register/flag writes were removed.
- If performance is flat, counters must explain whether the packet interpreter
  dispatch cost ate the local-state savings.

### Milestone 3: Compiler-Local Memory Groups

Add selected same-base page/window lowering for the hottest stable base+disp
groups. Keep fallback conservative.

Measurement:

- g2w group guard hit rate
- guard fallback rate
- g2w calls avoided
- direct-window versus sparse mapping behavior
- store invalidation count

Exit criteria:

- No generic `g2w` regression.
- Guard overhead is paid only in selected packets.
- The best hot blocks show fewer translations without adding more total time.

### Milestone 4: Broader Coverage Or Stop

Only after the clean subset wins:

- add partial-width register model
- add limited ESP/stack model
- add stack setup blocks
- consider trace-local packets across straight-line fallthroughs

If Milestone 2 cannot beat the existing threaded backend, stop and keep the
work as an analysis result. The block-local compiler can still use the same IR
to emit conventional specialized threaded primitives.

## Measurements To Keep Honest

Use both production-style timing and explainability counters:

```text
production timing:
  LABEL=<variant> RUNS=3 HANDLER_HIST=0 node tools/profile-aoe-repeat.js

hist/profile run:
  tools/profile-aoe-web.js with packet counters enabled

offline shape check:
  node tools/aoe-block-shape-census.js --profile=<hot-block-profile>
  node tools/aoe-reg-liveness-estimate.js --profile=<hot-block-profile>
  node tools/aoe-block-compiler-printer.js --profile=<hot-block-profile> --addr=<addr>
```

Track:

- `main.runSlice`
- guest/interpreter time
- present FPS only as a secondary signal
- outer threaded handler count
- packet entries
- current handlers replaced by packets
- dirty register flushes versus current writes
- flag writes skipped/materialized
- branch direct-eval count
- g2w calls and guarded page-window hits/fallbacks
- packet side exits
- code/thread arena size growth

Do not keep a variant based on a single noisy Chrome run.

## Acceptance Criteria

A stack-threaded target is worth continuing only if all of these are true:

- It remains a threaded-code backend, not runtime Wasm generation.
- It is optional and profile/shape selected; cold or unsupported blocks still
  use current threaded emission.
- Correctness is demonstrated on the AoE gameplay scenario and at least one
  register/flag consistency mode for allowlisted blocks.
- With handler histograms disabled, the 10s AoE repeat mean improves by at
  least 2% in guest/interpreter time, or by at least 1% with very strong
  counters showing a clear next step to recover overhead.
- Packet counters show real local savings: fewer register global writes, fewer
  flag materializations, and/or fewer g2w translations. Dispatch reduction
  alone is not enough.
- Debug/profiling behavior is not lost: either stack packets are disabled under
  debug flags, or packet-internal counters provide equivalent visibility.
- Fallback and side exits leave global machine state consistent with current
  handlers.

## Where This Likely Helps AoE

The best AoE fit is not tiny standalone branch fusion. Prior probes show those
are too marginal. The likely useful blocks are the combined candidates from
the shape census:

- clean 32-bit base+disp memory blocks with several accesses
- scalar/branch blocks where a compare/test feeds a Jcc and flags are dead on
  both exits
- blocks with repeated writes to the same non-ESP register before exit
- stable same-base memory families such as `[esi+disp]`, `[esp+disp]`,
  `[ebp+disp]`, and absolute `[disp]` loads/stores, once the stack/ESP model is
  ready

Examples from the current AoE notes:

- `0x00535e08` is a small clear example: `mov/add/dec/cmp/Jcc` can coalesce EDX
  writes and skip dead flag materialization, but it is too small by itself.
- `0x0049d9d1` looks more attractive because it combines many current
  dispatches, several register-write saves, and same-page g2w opportunities.
- `0x005086c4` has a high per-block score but is stack-heavy, so it should wait
  until an ESP/stack model exists.
- `0x00535b13` is a good mixed target after partial-width support, but not a
  first milestone.

## Recommendation

Treat stack-threaded code as a backend experiment after the normalized
block-local IR exists. Do not start by replacing the current handler set or by
trying to pass Wasm operand-stack values across `$next`.

The concrete next step is an offline stack-packet printer that uses the same
hot-block profile and liveness data already used by the AoE tools. If that
printer shows combined register, flag, and memory savings on the known hot
blocks, prototype a disabled-by-default `th_stack_block` for a tiny 32-bit clean
subset. Keep it only if no-hist repeated AoE timing improves and packet counters
show the expected work was actually removed.
