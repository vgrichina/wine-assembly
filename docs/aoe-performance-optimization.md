# AoE Performance Optimization Notes

## Current Measurement

Latest AoE campaign gameplay profile:

- Scenario: Bronze Age Art of War campaign, 10 seconds in-game.
- Actions: box-select starting units, issue three move orders, keep mouse active.
- Profile output: `/private/tmp/aoe-web-profile.json`.
- Raw CPU profile, when enabled: `/private/tmp/aoe-cpu-profile.json`.
- Use `HANDLER_HIST=0` for production-style timing after using the histogram to pick candidates.

Timing from the gameplay window:

```text
profile elapsed:       10011.9 ms
main.runSlice:          6580.6 ms
wrapped host imports:    362.0 ms
guest/interpreter:      6218.6 ms
present fps:              21.5
```

The bottleneck is the WAT x86 interpreter, not canvas repaint and not mostly DIB conversion.

Repeat timing command:

```sh
LABEL=baseline RUNS=3 HANDLER_HIST=0 node tools/profile-aoe-repeat.js
```

This writes `/private/tmp/aoe-repeat-<label>-{1,2,3}.json` plus a summary JSON
and prints mean/min/max/stddev. Use the histogram profiles to choose candidates,
then use this repeated no-hist timing before keeping a small optimization.

Hot-loop report command:

```sh
node tools/aoe-hot-block-report.js --top=8 --disasm=3
```

This reads the newest nonempty AoE handler-histogram profile in `/private/tmp`,
prints top handlers/pairs/SIB consumers/branch operands, clusters hot guest VAs,
and disassembles the hottest blocks from `Empires.exe`. Pass an explicit profile
path as the first argument when comparing older histogram runs.

## Measured Experiments

Single-run Chrome campaign profiles are noisy, but the direction has been consistent enough to prune several ideas:

```text
experiment                         profile file                                           main.runSlice   delta vs baseline
baseline                           /private/tmp/aoe-web-profile.json                          6580.6 ms      0.0%
Jcc specialized                    /private/tmp/aoe-web-profile-jcc-specialized.json          6571.9 ms     -0.1%
Jcc + push/pop specialized         /private/tmp/aoe-web-profile-jcc-pushpop.json              6562.3 ms     -0.3%
Jcc + push/pop + base load/store   /private/tmp/aoe-web-profile-jcc-pushpop-loadstorebase.json 6524.4 ms     -0.9%
br_table register helpers          /private/tmp/aoe-web-profile-reg-brtable.json              6618.1 ms     +0.6%
broad SIB fused handlers           /private/tmp/aoe-web-profile-sib-fused.json                6593.9 ms     +0.2%
direct stack load/store handlers   /private/tmp/aoe-web-profile-stackfast.json                6571.6 ms     -0.1%
```

Disposition:

- Keep the 355-handler specialization set: Jcc, push/pop r32, and simple base load/store r32.
- Revert `br_table` register helpers. WASM still needs nested block labels for `br_table`, and this workload was slower in Chrome.
- Revert broad SIB fused handlers. They reduced handler dispatch count, but larger/slower handlers lost more time than dispatch removal saved.
- Revert direct stack load/store handlers. Skipping `gs32/gl32` wrappers did not help this profile; guest time increased versus the 355-handler run.
- Keep the `PUSH ESP` correctness fix: x86 pushes the original ESP value, not the decremented value.

## Handler Histogram

The handler histogram is enabled only during the gameplay measurement window. Pair counts reset at decoded-block boundaries, so pair data is useful for superinstruction selection.

```text
total handlers:        368,967,847
intra-block pairs:     302,370,952
```

Top handlers:

```text
13.934%  $th_load32_ro
12.989%  $th_jcc
 6.648%  $th_push_r
 4.338%  $th_compute_ea_sib
 4.170%  $th_load32
 4.065%  $th_mov_r_r
 3.586%  $th_pop_r
 3.421%  $th_cmp_r_r
 2.979%  $th_store32_ro
 2.747%  $th_alu_r_m32_ro
```

Top intra-block pairs:

```text
3.861%  $th_load32_ro       -> $th_load32_ro
3.725%  $th_cmp_r_r         -> $th_jcc
3.061%  $th_alu_r_m32_ro    -> $th_jcc
2.976%  $th_push_r          -> $th_push_r
2.520%  $th_pop_r           -> $th_pop_r
2.401%  $th_compute_ea_sib  -> $th_load32
2.135%  $th_test_r_r        -> $th_jcc
1.856%  $th_push_r          -> $th_mov_r_r
1.702%  $th_load32_ro       -> $th_compute_ea_sib
1.632%  $th_push_r          -> $th_load32_ro
```

Category-level read:

```text
RO base+disp/SIB:   ~33%
loads/stores:       ~30%
branches/calls:     ~18%
stack:              ~12%
ALU/test/cmp:       ~62%
FPU:                 ~3%
```

Categories overlap because a handler can be both ALU and RO, or load/store and RO.

## Branch Operand Histogram

Profile output: `/private/tmp/aoe-web-profile-branch-operands.json`.

The branch operand histogram records producer operands only when the next threaded handler is a Jcc. This is more useful for choosing fusions than raw handler-pair counts.

```text
cmp_r_r -> Jcc total:          11,398,509
test_r_r -> Jcc total:          6,372,538
alu_r_m32_ro -> Jcc total:      9,373,017
```

Top `cmp_r_r -> Jcc` shapes:

```text
889,989  cmp ebp,ecx -> jl
876,525  cmp eax,ecx -> jge
847,520  cmp eax,edx -> jg
847,409  cmp ebp,edx -> jle
844,095  cmp eax,ebp -> jle
746,196  cmp ebx,ebp -> jl
461,092  cmp ecx,eax -> jg
446,390  cmp edi,ecx -> jl
```

Top `test_r_r -> Jcc` shapes:

```text
1,277,128  test eax,eax -> jz
  951,533  test eax,eax -> jnz
  857,627  test ebx,ebx -> jnz
  572,725  test esi,esi -> jz
  342,707  test edx,edx -> jge
  293,793  test eax,eax -> jl
```

Top `alu_r_m32_ro -> Jcc` shapes are all CMP forms:

```text
1,208,861  cmp ecx,[edi+disp] -> jl
1,190,395  cmp edx,[edi+disp] -> jle
  874,012  cmp eax,[ebp+disp] -> jl
  862,752  cmp edi,[esi+disp] -> jg
  842,302  cmp edi,[esi+disp] -> jl
  798,429  cmp edx,[ebx+disp] -> jl
```

Implication:

- The next fusion should target branch producers, not generic SIB or stack paths.
- A generic runtime `producer -> Jcc` fusion was tested in `/private/tmp/aoe-web-profile-branch-fused.json` and was effectively flat: `6539.2 ms` -> `6539.4 ms` in the hist-enabled profile.
- A narrower runtime `test r,r -> jz/jnz` fusion was tested in `/private/tmp/aoe-web-profile-test-jznz-fused.json` and regressed: `6539.2 ms` -> `6563.0 ms`.
- The likely issue is that runtime helpers still add hot-path peeking and generic condition work; they do not get the codegen benefit of purpose-built fused handlers.
- Next branch work should specialize only the top operand shapes above, starting with `test eax,eax -> jz/jnz` or the top `cmp reg,[base+disp] -> jcc` forms.

### Branch Fusion Probes

Several `test r,r -> jz/jnz` fusion variants were tried after the operand histogram. They reduced dispatch count, but did not produce a durable speedup.

```text
hist-enabled profile                                         main.runSlice   result
/private/tmp/aoe-web-profile-branch-operands.json              6539.2 ms     baseline
/private/tmp/aoe-web-profile-branch-fused.json                 6539.4 ms     flat
/private/tmp/aoe-web-profile-test-jznz-fused.json              6563.0 ms     slower by 23.8 ms
/private/tmp/aoe-web-profile-test-jcc-decode-fused.json        6621.9 ms     slower by 82.7 ms
/private/tmp/aoe-web-profile-test-jcc-specialized-fused.json   6592.3 ms     slower by 53.1 ms
```

Production-style no-hist timing was slightly more favorable for the shape-specific decode fusion, but too small to justify the code complexity without repeated-run confirmation:

```text
profile                                                       main.runSlice   guest/unwrapped
/private/tmp/aoe-web-profile-baseline-nohist.json               6241.8 ms       5865.6 ms
/private/tmp/aoe-web-profile-test-jcc-specialized-fused-nohist.json
                                                                 6222.6 ms       5842.6 ms
```

An even narrower `cmp r32,[base+disp] + signed Jcc` fusion was also tested
after the exact SIB jump win. It preserved CMP flags, then branched with direct
signed comparisons for `JL/JGE/JLE/JG`, so it avoided `$do_alu32` and the
separate Jcc flag-reader path but did not skip lazy flag writes.

```text
variant                                runSlice mean   runSlice sd   guest mean
jmp [disp+eax*4] kept baseline             6243.9 ms      10.6 ms     5876.1 ms
cmp r,[base+disp] + signed Jcc fused       6575.3 ms      36.8 ms     6159.4 ms
```

Profile files:

```text
/private/tmp/aoe-repeat-cmpmem-jcc-{1,2,3}.json
```

Conclusion:

- Do not keep `cmp r32,[base+disp] + signed Jcc` fused handlers.
- Preserving flags still requires the hot `set_flags_sub` work, and the larger
  fused handlers/codegen more than erase the saved dispatch and Jcc flag reads.
- Future branch work needs either proven flag-dead sites or larger trace/block
  compilation; another small flag-preserving compare/Jcc fusion is unlikely to
  pay off.

### Threaded IR Liveness Report

This is not a generated-Wasm direction. The scalable path is still generated
threaded code, but with a small IR pass after x86 parsing:

```text
x86 decode -> normalized IR -> local liveness/specialization -> threaded words
```

Compiler pipeline sketch:

```text
guest EIP
  |
  v
+-------------------+
| decode x86 bytes  |
| op/modrm/sib/imm  |
+-------------------+
  |
  v
+-------------------+      examples:
| normalized IR     | ---> cmp r32,[base+disp]
| explicit effects  |      test r,r
| explicit operands |      load32 dst,[base+disp]
+-------------------+      jcc cc,target
  |
  v
+------------------------------+
| local analysis per block     |
| - flag liveness              |
| - branch exits               |
| - concrete reg/base/index    |
| - hot profile weight         |
+------------------------------+
  |
  v
+----------------------------------------+
| threaded-code selection                |
|                                        |
| flags live?  -> existing safe handlers |
| flags dead?  -> *_jcc_dead primitive   |
| hot SIB?     -> exact SIB primitive    |
| generic case -> existing generic path  |
+----------------------------------------+
  |
  v
+-------------------------+
| emitted threaded words  |
| handler id + operands   |
+-------------------------+
  |
  v
current tail-call threaded interpreter
```

What the compiler can optimize before emitting threaded words:

```text
flag-dead branch producers
  cmp/test result used only by immediate Jcc, both exits overwrite flags first
  => skip set_flags_sub/set_flags_logic and branch directly

operand-specific memory ops
  [base+disp], [disp+eax*4], common SIB shapes
  => avoid generic EA helpers and sentinel paths only for measured hot shapes

dispatch reduction
  combine multiple IR ops only when the fused primitive removes real helper work
  => avoid one-dispatch fusions that just make bigger slower handlers

profile-directed selection
  hot block histogram chooses which primitives are worth adding
  => no broad "optimize every possible shape" handler bloat
```

RISC-like micro-IR model:

```text
x86 instruction:
  cmp edx, [ebx+0x8]
  jl target

micro-IR:
  t0 = add ebx, 0x8
  t1 = load32 t0
  t2 = sub edx, t1        ; produces virtual flags
  br_lt t2, target, fall

threaded output choices:
  if flags live:
    th_alu_r_m32_ro(cmp edx,[ebx+8])
    th_jcc_l(fall,target)

  if flags dead:
    th_cmp_r_m32_ro_jl_dead(edx, ebx, 8, fall, target)
```

Important constraint:

```text
Do not execute every micro-op as its own threaded handler.
That would increase dispatch count and likely regress.

Use micro-ops to reason, then pack them back into coarse threaded primitives.
```

Useful micro-IR nodes:

```text
EA(base,index,scale,disp)     address calculation, no memory side effects
LOAD(width, ea)               memory read
STORE(width, ea, value)       memory write
ALU(op, width, a, b)          arithmetic/logical value op
FLAGS(op, width, a, b, res)   virtual flags, can be dead
BR(cc, flags, fall, target)   conditional branch
MOV(dst, src)                 register transfer
CALL/JMP/RET/YIELD            hard block boundaries
```

What this buys:

```text
flag SSA/liveness
  flags become virtual values, not mandatory global writes.
  dead flags can disappear before threaded-code emission.

address specialization
  EA shape is explicit, so [base+disp] and [disp+eax*4] are easy to match.

primitive packing
  many x86 forms map to the same IR, then choose one measured threaded handler.

profile-guided code size
  only hot IR shapes get new primitives; cold shapes stay generic.
```

Register global-write estimate:

The same IR idea applies to general registers, not just flags. Flags are often
consumed by the immediate Jcc, while general registers are visible machine state
at block exits. A block compiler can still keep register values virtual inside a
block and flush each changed register once at exit.

Toy estimator command:

```sh
node tools/aoe-reg-liveness-estimate.js \
  --profile=/private/tmp/aoe-web-profile-hot-blocks-32k.json \
  --hot-limit=120
```

The estimator is offline only. It decodes hot block entries from the existing
profile, excludes ESP by default, treats all non-ESP registers as live at block
exit, and counts current full-register writes versus final block-exit flushes.

10s profile result:

```text
covered block entries:        37,475,452 / 66,254,912 = 56.6%
full register writes seen:    80,851,296
final block-exit flushes:     57,942,555
avoidable global writes:      22,908,741   28.3% of seen writes
avoidable vs dispatch count:        6.2%
identity writes:               2,072,787    2.6% of seen writes, 0.6% of dispatches
dead overwritten writes:               0
```

Naive timing scale from the same profile:

```text
main.runSlice:                          6,559.7 ms
guest/unwrapped:                        6,226.0 ms
block-compiler saved-write upper scale:   404.3 ms, 6.2% of runSlice
identity-write-only scale:                 36.6 ms, 0.6% of runSlice
```

This is not a benchmark. The scale assumes a saved register write is comparable
to one average handler-dispatch share, which is only a rough yardstick. The
useful conclusion is relative:

```text
identity-only handlers are small:       about 0.5-0.6%
true block-local virtual regs are real: about 6-7% dispatch-scale opportunity
trivial dead overwritten writes:        basically absent in the top AoE blocks
```

Example hot block:

```text
0x00535e08 count=747,413
  mov edx, edi
  add edx, ecx
  dec edx
  cmp edx, [ebx+0x8]
  jl 0x00535e7c

current threaded handlers write EDX three times.
block-local virtual-reg output writes EDX once at exit or side exit.
```

Toy block compiler printer:

```sh
node tools/aoe-block-compiler-printer.js \
  --profile=/private/tmp/aoe-web-profile-hot-blocks-32k.json \
  --addr=0x00535e08
```

This prints original instructions, approximate current threaded handlers, and a
block-local virtual-register/virtual-flag lowering. It is not executable code;
it is a shape report before runtime compiler work.

Example output shape:

```text
0x00535e08
  original:
    mov edx, edi
    add edx, ecx
    dec edx
    cmp edx, [ebx+0x8]
    jl 0x00535e7c

  current:
    5 threaded dispatches
    3 EDX global writes
    1 g2w call

  toy optimized:
    v_edx = edi
    v_edx = edi + ecx
    v_edx = edi + ecx - 1
    wa0 = g2w(ebx + 0x8)
    branch jl using sub(v_edx, load32(wa0))
    exit flush: edx
    flag exits: fall=dead target=dead, skip flag global write
```

Top hot blocks show two different classes:

```text
compare/Jcc-only blocks
  no register-write savings, but flag-dead direct branch is useful.

multi-op blocks like 0x00535e08
  register writes coalesce well inside a block.

stack/setup blocks
  often need register flushes and do not benefit much from block-local
  virtual registers unless we also model ESP/stack effects.
```

Another register-write example:

```text
0x00535aa0
  mov edi, [esi+eax*4]
  or edi, edi
  jz 0x005362e0

`or edi,edi` is an identity register write. It only needs flags, so it can be
selected as a flag-only/test-like primitive without a register global write.
```

Block-shape classifier:

```sh
node tools/aoe-block-shape-census.js \
  --profile=/private/tmp/aoe-web-profile-hot-blocks-32k.json \
  --hot-limit=120 \
  --top-rows=10 \
  --page-size=4096
```

This aggregates the printer/estimator view across hot blocks. It reports
primary buckets, overlapping optimization signals, exact branch candidates,
register-coalescing block signatures, and EA/g2w access shapes.

10s hot-block result:

```text
covered block entries:            37,475,452 / 66,254,912 = 56.6%
current dispatches in covered:   180,833,002   48.7% vs all handlers
branch fusion dispatch saves:     25,821,011    6.9% vs all handlers
flag-dead branch opportunities:   12,337,847   32.9% of covered blocks
coalescible register writes:      22,908,741    6.2% vs all handlers
identity register writes:          2,072,787    0.6% vs all handlers
```

EA/g2w result:

```text
blocks with any EA/g2w access:        27,905,410   74.5% of covered blocks
blocks with multiple EA/g2w accesses: 11,813,270   31.5% of covered blocks
blocks with repeated same EA/g2w:      1,326,604    3.5% of covered blocks
blocks with related EA families:       7,206,299   19.2% of covered blocks
current g2w-like memory accesses:     61,093,519   16.4% vs all handlers
repeated-EA g2w saves in block:        2,227,338    0.6% vs all handlers
related-EA memory accesses:           24,393,499   39.9% of current g2w accesses
related-EA adjacent pairs:            15,005,785    4.0% vs all handlers
related-EA delta 4 pairs:              8,875,574    2.4% vs all handlers
related-EA delta <=16 pairs:          11,467,923    3.1% vs all handlers
stable same-base multi-disp blocks:    5,191,649   13.9% of covered blocks
stable same-base accesses:            18,656,045   30.5% of current g2w accesses
stable same-base page-range blocks:    5,191,649   13.9% of covered blocks
stable same-base page-range groups:    5,851,756
stable same-base page-range accesses: 18,656,045   30.5% of current g2w accesses
stable same-base page g2w saves:      12,804,289    3.4% vs all handlers
consecutive same-base page blocks:     4,688,157   12.5% of covered blocks
consecutive same-base page pairs:      7,110,263    1.9% vs all handlers
```

Interpretation:

```text
repeated same-EA reuse is small on its own.
stable same-base small-window reuse is much larger.
one page-window translation per stable group is a 12.8M g2w-save estimate,
about 5.7x the exact repeated-EA CSE estimate.
all EA/g2w access is large enough to keep high priority.
best g2w work is likely fast-path mapping or base-window prechecks,
not only exact common-subexpression reuse inside a block.
```

Top EA/g2w access shapes:

```text
13,153,396  [esi+disp]
12,118,926  [esp+disp]
 9,479,384  [disp]
 4,250,660  [ebp+disp]
 3,049,812  [edi+disp]
```

Top stable same-base page-range families:

```text
874,688  [esp+disp] range=0x4  disps=+0x4,+0x8
849,566  [esp+disp] range=0x4  disps=+0x14,+0x18
480,494  [esi+disp] range=0x20 disps=+0x0,+0x4,+0x14,+0x18,+0x20
468,091  [esi+disp] range=0x4  disps=+0x40,+0x44
380,359  [eax+disp] range=0xc  disps=+0x0,+0x4,+0x8,+0xc
380,359  [esi+disp] range=0x10 disps=+0x3c,+0x40,+0x44,+0x48,+0x4c
355,685  [esp+disp] range=0x4  disps=+0x18,+0x1c
327,536  [esi+disp] range=0xa4 disps=+0x28,+0x30,+0xcc
```

Potential base-window primitive:

```text
block has a stable base register feeding [base+d0], [base+d1], ...
and max(d) - min(d) < 4096

guest_min = base + min_disp
guest_max = base + max_disp + access_width - 1

if guest_min and guest_max are in the same mapped/direct page:
  wasm_base = g2w_page_base(guest_min)
  access wasm_base + page_offset(guest_min) + (disp - min_disp)
else:
  fallback to normal per-access g2w
```

Important caveat:

```text
offset range < page size is not enough by itself.
the base value must stay unchanged between the grouped accesses.
base + min_disp can still straddle a guest page or sparse allocation boundary.
the fast path needs a runtime same-page/contiguous-mapping guard.
```

Broad g2w page-cache probe:

```text
variant                    runSlice mean   guest mean   result
baseline no-hist             6243.9 ms     5876.1 ms   prior measured baseline
g2w page cache                6598.9 ms     6208.8 ms   slower by 355.0 ms
```

Profile files:

```text
/private/tmp/aoe-repeat-g2w-page-cache-{1,2,3}.json
/private/tmp/aoe-repeat-g2w-page-cache-summary.json
```

Conclusion:

```text
do not add a generic g2w page cache.
the added branch/global traffic in every g2w call costs more than it saves.
same-base page-window work still needs compiler-selected grouped primitives,
not a broad cache inside every memory translation.
```

Top consecutive same-base page pairs:

```text
pair kind totals:
4,925,238  load->load
1,564,657  store->store
  480,494  load->store
  139,874  store->load

849,566  load->load  [esp+disp] +0x18 -> +0x14 delta=-0x4
731,268  load->load  [esp+disp] +0x8  -> +0x4  delta=-0x4
480,494  load->load  [esi+disp] +0x18 -> +0x14 delta=-0x4
480,494  load->load  [esi+disp] +0x14 -> +0x0  delta=-0x14
480,494  load->store [esi+disp] +0x4  -> +0x18 delta=+0x14
468,091  load->load  [esi+disp] +0x44 -> +0x40 delta=-0x4
380,359  store->store [eax+disp] +0x4 -> +0x0  delta=-0x4
380,359  store->store [eax+disp] +0x0 -> +0x8  delta=+0x8
```

Interpretation:

```text
a tiny consecutive pair primitive has a 7.1M-pair surface, about 1.9%.
that is smaller than full stable grouped reuse, but easier to emit.
the obvious adjacent load->load handler was tested and did not win.
future work should target compiler-local memory lowering, not a generic pair op.
```

Runtime load-pair probes:

```text
variant                    runSlice mean   guest mean   result
baseline no-hist             6243.9 ms     5876.1 ms   prior measured baseline
loadpair page/direct guard    n/a           n/a         run1 6744.9 ms, later run hit drag timeout
loadpair direct guard         6555.5 ms     6150.7 ms   slower by 311.6 ms runSlice
loadpair dispatch-only        6248.0 ms     5869.0 ms   neutral, +4.1 ms runSlice
```

Profile files:

```text
/private/tmp/aoe-repeat-loadpair-1.json
/private/tmp/aoe-repeat-loadpair-direct-{1,2,3}.json
/private/tmp/aoe-repeat-loadpair-direct-summary.json
/private/tmp/aoe-repeat-loadpair-dispatch-{1,2,3}.json
/private/tmp/aoe-repeat-loadpair-dispatch-summary.json
/private/tmp/aoe-web-profile-loadpair-hist-smoke.json
```

Histogram confirmation:

```text
1s gameplay with handler histogram:
handler 356 load32_pair_ro_samebase count=650,741
handler 356 share=1.932% of 33,690,499 handler dispatches
```

Conclusion:

```text
simple adjacent load-pair fusion has real surface but no measured speedup.
direct-window guards inside the fused handler are actively bad.
dispatch-only fusion proves removing about 1.9% of dispatches is not enough.
memory optimization needs a compiler stage that keeps base/address temporaries
live across several ops and avoids repeated get/set/g2w work without adding
branches to every fused handler.
```

Current priority from the classifier:

```text
1. exact flag-dead cmp/test/identity-ALU + Jcc selection
2. block-local virtual registers for multi-op hot blocks
3. compiler-local grouped memory lowering for simple [base+disp] groups
4. broader EA/g2w fast-path or exact memory primitives
5. repeated same-EA reuse only after the broader g2w path is understood
```

The report command now supports optional hot-block weighting:

```sh
node tools/superinstruction-census.js \
  --profile=/private/tmp/aoe-web-profile-hot-blocks-32k.json \
  --hot-limit=120 \
  test/binaries/shareware/aoe/aoe_ex/Empires.exe
```

Static executable-wide result:

```text
cmp r,[mem]; jcc                  919 sites
cmp r,[base+disp]; jcc            858 sites
cmp r,[mem]; signed jcc           457 sites
cmp r,[mem]; jcc flags dead       384 sites
cmp r,[base]; signed dead         226 sites
test r,r; jcc                    9027 sites
test r,r; jcc flags dead         1557 sites
test r,r self; dead              1553 sites
```

Hot-block weighted result from the 10s profile, top 120 hot block entries:

```text
covered block entries:        37,475,452 / 66,254,912 = 56.6%
cmp r,[mem]; jcc               8,301,249   22.2% of covered
cmp r,[base+disp]; jcc         6,772,778   18.1% of covered
cmp r,[mem]; signed jcc        7,820,755   20.9% of covered
cmp r,[mem]; jcc flags dead    3,782,436   10.1% of covered
cmp r,[base]; signed dead      3,434,177    9.2% of covered
test r,r; jcc                  2,932,946    7.8% of covered
test r,r; jcc flags dead         420,900    1.1% of covered
```

ASCII TLDR:

```text
Do not make more flag-preserving branch fusions.
Do make decode-time IR/liveness decide when flags are dead.
Best next primitive: cmp r32,[base+disp] + signed Jcc, flag-dead only.
Second primitive: test r,r + Jcc, flag-dead only.
Keep output as threaded code, not generated Wasm.
```

Threaded primitive direction:

- Add an IR node for parsed branch producers with explicit flag effects.
- Compute whether both branch exits overwrite flags before reading them.
- Emit normal existing threaded handlers if flags might be live.
- Emit a special `*_jcc_dead` threaded primitive only when flags are proven dead.
- The primitive should branch directly and skip `set_flags_sub`/`set_flags_logic`.
- Keep the primitive operand-specific enough to avoid the generic helper cost
  that made the flag-preserving fusion regress.

Conclusion:

- Do not keep the current branch-fusion WAT handlers.
- Avoid broad generic fused handlers that remove one dispatch but add operand/condition branches.
- If branch fusion is revisited, prefer generated trace-specific blocks or larger superinstructions that remove several dispatches at once.
- Measure with handler histograms disabled before keeping any small win.

## Hot Block And SIB Consumer Histograms

The handler histogram now also records guest block-entry EIPs and the concrete consumer of `$th_compute_ea_sib`. This helps separate "which emulator handlers are hot" from "which AoE routines and SIB shapes are hot."

Profile outputs:

```text
/private/tmp/aoe-web-profile-hot-blocks-32k.json   10s hot-block exploration
/private/tmp/aoe-web-profile-sib-fixed3.json       1s SIB consumer validation
```

Hot-block 32K table result:

```text
block entries:    66,254,912
occupied slots:        8,071
collisions:       1,145,088   1.73%
```

Top hot block entries from the 10s run:

```text
857,843  0x00535b56  rva 0x00135b56
850,107  0x0049dd20  rva 0x0009dd20
~846K    0x0049dd33..0x0049dd7e cluster
830,965  0x00536420  rva 0x00136420
```

Disassembly read:

- `0x0049dd20` is a small branch-heavy range/list update routine.
- `0x00535b4d..0x005362e0` is a linked-list/bounds loop in `THIS_COD`.
- `0x004c5fa0` is a small linear search loop over about `0x28` entries.
- `0x0045c280` is a compact bitfield/tile-state update path.

SIB consumer validation from the 1s run:

```text
recorded SIB events:  1,523,029
table total:          1,504,774
occupied keys:              202
collisions/lost:         18,255   1.20%
```

Top SIB consumer shapes:

```text
149,324  jmp_ind   op=0x0  [none+eax*4+disp]
113,781  load32    op=0x7  [esi+eax*4+disp]
 89,552  load32    op=0x0  [eax+edx*4+disp]
 63,834  load32    op=0x3  [edi+eax*1+disp]
 62,488  load8     op=0x3  [ecx+eax*8+disp]
 62,350  alu_r_m32 op=0x71 [edi+edx*4+disp]
 58,718  load32    op=0x6  [eax+ecx*4+disp]
 54,015  mov_r16_m16 op=0x0 [esi+ebx*4+disp]
```

Hot-loop split from the 10s hot-block run:

```text
profile:              /private/tmp/aoe-web-profile-hot-blocks-32k.json
elapsed:              10019 ms
main.runSlice:         6559.7 ms
wrapped host imports:   333.7 ms
guest/unwrapped:       6226.0 ms
```

The split below is block-count based, not exact wall-clock time. It is still
useful because the top 120 recorded hot block entries cover 56.6% of all guest
block entries in the sample.

```text
bucket                    guest block share   est. runSlice time
span/region builder              20.8%              1363 ms
blitter command decoder          19.7%              1292 ms
tile bitfield updates             2.2%               145 ms
entity render glue                2.0%               134 ms
40-slot linear search             1.8%               116 ms
x87 float->int helper             1.2%                77 ms
negative-id lookup                0.9%                62 ms
other top-120 blocks              8.0%               522 ms
long tail / not top-120          43.4%              2846 ms
```

Disassembly interpretation of the two largest buckets:

- `0x0049dd20` and callers around `0x0043d048` build/clamp horizontal
  span ranges across rows and maintain per-row linked lists. This is branchy,
  pointer-heavy dirty/visibility/coverage bookkeeping.
- `0x005359a0`, `0x00535c20`, `0x00535e00`, and `0x00536420` are AoE's
  software blitter/command decoder. They walk span lists, decode byte commands,
  use jump tables, clip runs, and write pixels.

### Exact SIB Jump Probe

An exact handler for the hottest SIB shape was tested:

```text
candidate: jmp [disp+eax*4]
profile:   /private/tmp/aoe-web-profile-jmp-sib-eax4-1s.json
```

The handler worked mechanically. In the 1s hist-enabled profile it ran 167,340
times, and the old generic SIB/jump path dropped accordingly:

```text
metric                         previous 1s      exact-SIB 1s
compute_ea_sib count             1,523,029        1,355,298
jmp_ind count                      210,392           74,394
new exact handler count                  0          167,340
```

A single no-hist run was misleading, so the timing comparison was repeated with
three full 10s gameplay profiles per variant:

```text
variant          runSlice mean   runSlice sd   guest mean   present fps mean
baseline             6312.8 ms      48.6 ms     5940.6 ms          22.45
jmp [disp+eax*4]     6243.9 ms      10.6 ms     5876.1 ms          23.01
jmp + load SIB       6242.0 ms       1.3 ms     5874.6 ms          23.08
```

Profile files:

```text
/private/tmp/aoe-repeat-baseline-{1,2,3}.json
/private/tmp/aoe-repeat-jmp-sib-eax4-{1,2,3}.json
/private/tmp/aoe-repeat-jmp-load-sib-{1,2,3}.json
```

Conclusion:

- Keep the exact `jmp [disp+eax*4]` handler. It reduces `main.runSlice` by
  about 68.9 ms over the 10s gameplay window, or about 1.09%.
- Do not keep the exact `edi = [esi+eax*4+disp]` load handler. Adding it on top
  of the jump handler improves the mean by only 1.9 ms, about 0.03%, which is
  not enough to justify the extra handler.
- Repeated no-hist runs are required for small interpreter changes. The earlier
  single-run exact-SIB conclusion was wrong because it overfit one noisy run.
- Bigger block-local or trace-local work is still more promising than piling on
  many isolated single-op SIB fusions.

Implication:

- The broad generic SIB-fused handler experiment was too large and regressed, but the shape histogram shows narrower candidates.
- The highest SIB payoff is not just `compute_ea_sib -> load32`; `jmp_ind`, `load8`, `alu_r_m32`, and 16-bit memory load shapes are material too.
- Next SIB work should require repeated no-hist wins before keeping code; the exact jump-table handler passed that bar, but the exact load handler did not.
- The hot-block data suggests bigger block-local or trace-local work may be more valuable than adding one more small fused handler.

## Optimization Ideas

### 1. Specialize Jcc

`$th_jcc` is the second hottest handler. It calls `$eval_cc`, which is generic over all x86 condition codes. The hottest pairs are `cmp/test/alu -> jcc`, so branch evaluation is a good first target.

Candidate work:

- Add separate handlers for common conditions: JZ/JNZ/JL/JGE/JLE/JG/JA/JBE.
- Decode those Jcc opcodes directly to specialized handlers.
- Avoid `$eval_cc` switch-like logic for common cases.
- For `cmp_r_r -> jcc` and `test_r_r -> jcc`, consider fused compare/test-and-branch handlers.

Expected benefit:

- Reduces branch handler cost.
- Reduces helper calls into lazy flag readers.
- May improve block throughput without changing host-side rendering.

Risk:

- Need exact lazy-flag semantics, especially signed comparisons that use SF/OF.
- Must preserve parity/carry cases for less common condition codes.

### 2. Fuse SIB Compute With Memory Operation

`$th_compute_ea_sib -> $th_load32` is a top pair. The current design computes EA into global `$ea_temp`, then the following handler reads through the sentinel path. That costs one extra handler dispatch and a global temporary.

Candidate work:

- Add direct SIB load/store/ALU handlers:
  - `load32_sib`
  - `store32_sib`
  - `load8_sib`
  - `alu_r_m32_sib`
  - `jmp_ind_sib`
- Change decoder emission from `compute_ea_sib + op` to one fused handler when the consumer is known.

Expected benefit:

- Removes one dispatch per complex addressing memory op.
- Avoids `$ea_temp` and sentinel checks.
- Directly attacks a clear top pair.

Measured result:

- A broad `load32_sib`, `store32_sib`, and `jmp_ind_sib` experiment reduced total handler count from about 371M to about 361M, but `main.runSlice` worsened from `6524.4 ms` to `6593.9 ms`.
- The likely issue is handler bloat/codegen: fewer dispatches did not beat a larger SIB EA path inside hot handlers.

Risk:

- More handler table entries.
- Need careful coverage for absolute/SIB/no-base forms.

Next version, if revisited:

- Use operand histograms first.
- Specialize only the most common SIB shapes, such as fixed base/index/scale combinations, rather than one generic SIB fused helper.
- Compare against the current `compute_ea_sib + consumer` path after each small addition.

### 3. Stack Fast Paths

`push_r -> push_r`, `pop_r -> pop_r`, and `pop_r -> ret_imm` are very hot. Current push/pop uses generic register helpers and `gs32/gl32`.

Candidate work:

- Add register-specialized push/pop handlers for common registers.
- Add batch handlers for repeated pushes/pops, especially function prolog/epilog shapes.
- Add a stack store/load fast path that skips code invalidation for stack-range addresses.

Expected benefit:

- Reduces register helper calls.
- Reduces memory helper cost.
- May help call-heavy game code and MFC/Win32 glue code.

Risk:

- `pop esp` has special semantics and must remain correct.
- Stack fast paths must not hide real self-modifying-code writes outside stack memory.

Measured result:

- Direct `i32.store/load (g2w esp)` in specialized push/pop regressed versus the current 355-handler run: `6524.4 ms` -> `6571.6 ms`.
- Skipping the store invalidation helper is not enough by itself, and the larger handler bodies appear to hurt Chrome.
- This is still worth revisiting for `call`, `ret`, `push imm`, `pushfd`, and batch push/pop shapes, but only with a narrower measurement.

### 4. Register Specialization

CPU sampling shows `$get_reg` and `$set_reg` are expensive. Handler histogram confirms generic register-heavy handlers dominate.

Candidate work:

- Replace `get_reg/set_reg` chains with `br_table` helpers.
- Better: emit register-specific handlers for the most common forms.
- Start with common `load32_ro`, `mov_r_r`, `cmp_r_r`, `push_r`, `pop_r`.

Expected benefit:

- Cuts repeated 8-way if chains in hot handlers.
- Makes handlers more direct and more JIT-friendly.

Risk:

- Handler-table growth.
- More code to maintain.

Measured result:

- Replacing `get_reg/set_reg` chains with `br_table` helpers was slower in the AoE Chrome profile.
- Register-specific handlers are still viable; `br_table` helper replacement is not currently justified.

### 5. Memory Translation Fast Paths

CPU sampling showed `$g2w` hot. The direct mapping path is already simple arithmetic, but every load/store still calls it.

Candidate work:

- Inline direct guest-window translation inside hot memory handlers.
- Fall back to `$g2w` only when the translated address is outside the direct window.
- Combine this with RO and SIB fused handlers.

Expected benefit:

- Helps `load32_ro`, `store32_ro`, `load8_ro`, and ALU memory ops.

Risk:

- Must preserve sparse VirtualAlloc mapping behavior.
- Must preserve null-page sentinel behavior.

### 6. Superinstructions

Top pairs suggest concrete fusions:

```text
load32_ro + load32_ro
cmp_r_r + jcc
alu_r_m32_ro + jcc
push_r + push_r
pop_r + pop_r
compute_ea_sib + load32
test_r_r + jcc
push_r + mov_r_r
load32_ro + cmp_r_r
load32_ro + test_r_r
```

Good first superinstructions:

- `cmp_r_r_jcc`
- `test_r_r_jcc`
- `alu_r_m32_ro_jcc`
- `load32_ro_load32_ro`
- `push_r_push_r`
- `pop_r_pop_r`
- `compute_sib_load32`

Expected benefit:

- Reduces `$next` dispatch and `call_indirect`.
- Reduces threaded-code memory traffic.
- Directly targets the largest measured pair counts.

Risk:

- Needs decoder changes and handler-table expansion.
- Fused handlers must still respect block-end/control-flow boundaries.

## Future Directions To Explore

### Longer N-Gram Profiling

Pair histograms are enough for first superinstructions, but triples could reveal stronger patterns:

- `load32_ro -> cmp_r_r -> jcc`
- `inc_r -> cmp_r_r -> jcc`
- `push_r -> push_r -> call_rel`
- `pop_r -> pop_r -> ret_imm`

Use a bounded top-K hash table instead of a dense matrix for triples.

### Guest EIP Hot Blocks

Handler-level data tells what kind of emulator work is hot; hot-block data now shows which AoE guest routines drive it.

Next measurements:

- Add a compact per-hot-block handler-sequence sample so EIP clusters can be tied to concrete threaded op streams.
- Disassemble the top EIP clusters automatically into profile output.
- Use those sequences to decide whether local block compilation would pay off.

### Block-Local Native-ish Compilation

The current threaded interpreter emits handler IDs. A next step could emit block-specific WAT-like sequences or JS-generated wasm for hot blocks.

Options:

- Keep threaded interpreter for cold code.
- Promote very hot guest blocks to specialized WASM code.
- Start with blocks that use only common integer/memory ops.

This is much larger work, but it is the most direct path beyond superinstructions.

### Lazy Flag Refinement

Many hot branches need only ZF, SF, OF, or CF. Current lazy flag state is general.

Ideas:

- Track condition-specific cheap flag values for recent CMP/TEST/ALU.
- Add fused compare/test branch handlers that compute only the needed branch result.
- Avoid materializing flags unless PUSHFD/LAHF/SETcc needs them.

### Stack/Code Invalidation Separation

Stores currently guard against self-modifying code. Stack writes are frequent and should almost always skip that path.

Ideas:

- Add `gs32_stack` / `gl32_stack` fast helpers.
- Use them for push/pop/call/ret when ESP is inside the known guest stack range.
- Keep generic stores for unknown memory.

### SIMD/MMX

MMX/SIMD is probably not a first-order CPU win for AoE right now. The hot data is scalar interpreter dispatch, register muxing, memory translation, and branch evaluation. SIMD may still help DIB conversion or bulk memory/string ops, but that is not where the 10s gameplay profile spends most time.

### Browser/Runtime Sensitivity

Repeat these profiles in:

- Chrome normal/headless.
- Safari.
- Different `RUN_SLICE` values.
- With and without CPU profiling.
- With handler histogram disabled after using it for candidate selection.

The histogram itself adds overhead, so use it to pick changes, then verify speed without it.

## External WASM-Centric References

These sources are specifically about WebAssembly emulators, x86-to-WASM translation, or WASM runtime benchmarking. They are more relevant than generic JavaScript emulator advice.

### x86-to-WASM Systems

- v86: https://github.com/copy/v86 and https://github.com/copy/v86/blob/master/docs/how-it-works.md
  - v86 translates hot x86 machine code into WebAssembly modules at runtime.
  - Its notes call out the same WASM constraints that matter here: structured control flow, no arbitrary patching, no direct control over physical registers, module generation overhead, and per-module memory overhead.
  - It uses an interpreted mode to collect hot entry points/pages, then emits code for hot pages.
  - Its generated memory fast path is TLB-like: validate page entry and offset bounds, then do direct memory access; fall back to a slow path for page faults/MMIO/code pages.
  - It uses lazy flags and notes x87/softfloat as slow.

- CheerpX/WebVM: https://labs.leaningtech.com/blog/webvm-server-less-x86-virtual-machines-in-the-browser and https://cheerpx.io/docs/overview
  - CheerpX is a two-tier x86 emulator: interpreter for rare code and structure discovery, x86-to-WASM JIT for hot code.
  - It generates WebAssembly modules from hot x86 code on the fly.
  - This independently supports the "cold interpreter + hot block promotion" direction.

- JSLinux/TinyEMU: https://bellard.org/jslinux/tech.html
  - Current JSLinux is based on TinyEMU and compiled to JavaScript or WASM with Emscripten.
  - Bellard notes that careful C/Emscripten tuning became faster than the earlier hand-coded asm.js version.
  - Reported x86 emulator speed was about 100 MIPS on a typical 2017 desktop PC in Firefox.
  - It supports broad x86 features, including MMX/SSE-family features, but that is guest ISA support, not a guarantee that host WASM SIMD is the bottleneck or win.

### Emulator Benchmark Sources

- WasmBoy: https://github.com/torch2424/wasmboy and https://medium.com/@torch2424/webassembly-is-fast-a-real-world-benchmark-of-webassembly-vs-es6-d85a23f8e193
  - Game Boy/Game Boy Color emulator written for WebAssembly using AssemblyScript.
  - Its benchmark compares the same core emitted as WASM, ES6, and Closure-compiled JS by running frame workloads.
  - Useful methodology point: benchmark per-frame work, drop warmup frames, and test multiple ROM workloads because CPU, audio, and graphics stress different paths.
  - Their results show WASM usually wins, but the factor varies heavily by browser, device, language/compiler output, and workload.
  - Their gotchas match our renderer split: JS/WASM boundary overhead matters, so keep crossings coarse.

- 8bitworkshop emulator performance: https://8bitworkshop.com/docs/posts/2021/webassembly-vs-javascript-emulator-performance.html
  - Compares browser emulator variants: native JS, MAME compiled to WASM, and headless C emulators compiled to WASM.
  - The "native WASM" headless C emulators expose a C Machine API and keep debugging/tracing support.
  - A key lesson for us: avoid per-cycle JS/WASM calls; buffer video/trace data and cross the boundary at scanline/frame or batch granularity.
  - WASM is not automatically multiples faster than JS. MAME-WASM was much heavier than lightweight JS/WASM emulators, while native headless WASM was efficient.
  - The update notes browser interop details can dominate results; replacing a JS Proxy path made WASM equally fast across browsers in their case.

- Tiny Emus/chips-test: https://floooh.github.io/tiny8bit/ and https://github.com/floooh/chips-test
  - Collection of C 8-bit computer/console emulators compiled to WebAssembly through Emscripten.
  - Useful as an example of small, headless, C emulator cores with native and WASM builds.

### WASM Runtime And Measurement Papers

- WAMR fast interpreter design: https://www.intel.com/content/www/us/en/developer/articles/technical/webassembly-interpreter-design-wasm-micro-runtime.html
  - Relevant even though it is a WASM interpreter, not an x86 emulator.
  - It reports large gains from dispatch optimization, bytecode fusion, reducing decode overhead, and converting stack-style operations toward register-style execution.
  - This backs our pair/triple histogram, superinstruction, and register-specialization work.

- A Fast In-Place Interpreter for WebAssembly: https://www.cs.tufts.edu/~nr/cs257/archive/ben-titzer/wasm-interp.pdf
  - This is about interpreting WASM in a native engine, but its dispatch findings are directly relevant.
  - Native threaded dispatch was fastest: average 14% faster, maximum 29% faster than non-threaded dispatch.
  - Dispatch table entry layout mattered: 4-byte direct table entries were often up to 10% faster than alternatives.
  - It also notes wasm3 uses classic threaded code internally, and disabling wasm3's jump table reportedly reduces performance by more than 2x.
  - Caveat: these wins depend on native assembly/C extensions. They do not automatically transfer to a WAT-level `call_indirect` loop.

- Not So Fast, WebAssembly vs native: https://arxiv.org/abs/1901.09056
  - SPEC CPU in browsers found substantial native-vs-WASM gaps for larger programs.
  - Practical implication: "WASM is near native" is not a planning assumption for this project. We need direct profiles, not generic expectations.

- Understanding the Performance of WebAssembly Applications: https://weihang-wang.github.io/papers/imc21.pdf
  - Benchmarks real web apps and C benchmark suites across Chrome/Firefox/Edge.
  - Includes WasmBoy as a real-world WASM application benchmark.
  - Useful for methodology: browser, compiler, input size, and optimization level materially change results.

- Wasm-R3: https://software-lab.org/publications/oopsla2024_Wasm-R3.pdf
  - Focuses on realistic, standalone, repeatable WASM benchmarks captured from web applications.
  - Useful for future profile design: automate realistic interactions, isolate external resources, run repeated measurements, and compare browser engines plus standalone engines.

### Dispatch Strategy Comparisons

There is no universal answer that `br_table`, `call_indirect`, or tail-call dispatch is best for an interpreter written in WASM. The result depends on engine lowering, handler count, state passing, and whether the runtime can keep interpreter state in machine registers.

Approaches:

- `call_indirect` threaded handlers:
  - Closest to our current design.
  - Pros: simple modular handlers, easy handler table growth, easy profiling by handler.
  - Cons: every guest op pays an indirect function call, table/type checks unless optimized away, and separate handler functions make it harder for the browser engine to keep interpreter state in registers.
  - Native threaded interpreters win partly because they end each handler with a raw indirect jump, not a WASM function call.

- `br_table` switch loop:
  - Encodes a dense switch in one function.
  - Pros: avoids a WASM function call per instruction; locals may stay in one function, so register allocation can be better.
  - Cons: dispatch returns to a central loop, so it is not true direct-threaded dispatch; a 300+ case switch can stress engine-specific `br_table` lowering; one giant function can be harder to maintain and may compile slower.
  - Historical data: Mono/Emscripten reported a large `br_table` scaling issue in SpiderMonkey/JSC compared with V8: https://bugzilla.mozilla.org/show_bug.cgi?id=1641599

- Tail-call handler dispatch:
  - In theory, each handler tail-calls the next handler, approximating threaded dispatch.
  - Evidence is mixed. A Python/Emscripten experiment reported about a 12% benefit over switch dispatch: https://discuss.python.org/t/interpreter-dispatch-and-performance-on-webassembly/27246
  - Other measurements are negative: one Firefox WASM tail-call microbenchmark found tail calls 39.2% slower than a jump-table style test: https://mjestecko.neocities.org/articles/firefox-wasm-tail-call-benchmark
  - A 2026 Raven VM comparison found tail-calling interpreters worked well natively but were much worse in some WASM runtimes, especially Chrome/Wasmtime: https://wingolog.org/archives/2026/04/07/the-value-of-a-performance-oracle
  - Wasmtime's Pulley interpreter documents both a match loop and a tail loop; the tail loop is thought to be faster, but is not default because tail-call optimization is not portable/stable in Rust/LLVM: https://docs.wasmtime.dev/examples-pulley.html

Practical implication for this project:

- Do not assume replacing `call_indirect` with a huge `br_table` is a guaranteed win.
- A focused local microbenchmark is required: same handler set, same guest trace, Chrome and Safari, compare `call_indirect`, `br_table`, and maybe a smaller `br_table` by hot handler subset.
- Before a full dispatch rewrite, pair-driven superinstructions are lower-risk because they reduce dispatch count regardless of whether dispatch is `call_indirect` or `br_table`.
- If we test `br_table`, start with a generated prototype for the hottest 32-64 handlers plus fallback rather than a full 307-handler rewrite.

### WASM Features Relevant To Future Work

- Emscripten SIMD: https://emscripten.org/docs/porting/simd.html
  - WebAssembly SIMD is broadly supported, but native x86 inline SIMD assembly is not supported, and not all x86 SIMD idioms map cleanly.
  - For AoE today, SIMD likely helps DIB conversion or bulk memory/string ops before it helps scalar x86 interpreter dispatch.

- Emscripten pthreads: https://emscripten.org/docs/porting/pthreads.html
  - WebAssembly pthreads use Web Workers and SharedArrayBuffer.
  - Blocking on the browser main thread is problematic and can busy-wait or deadlock with proxied work.
  - Worker pools matter because creating a worker can require returning to the browser event loop.

## Suggested Next Order

1. Keep and commit the measured 355-handler specialization set.
2. Use operand histograms for candidate selection, then verify with `HANDLER_HIST=0`.
3. Add hot block/EIP sequence profiling so superinstructions can be tied to actual AoE routines, not only global pair counts.
4. Revisit branch fusion only as generated trace-specific blocks or larger multi-op superinstructions.
5. Revisit SIB only as shape-specific handlers after operand/addressing histograms identify exact forms.
6. Revisit stack only as batch prolog/epilog or call/ret forms, not as generic direct stack load/store replacement.
7. Explore triple histograms once pair-driven wins flatten out.
