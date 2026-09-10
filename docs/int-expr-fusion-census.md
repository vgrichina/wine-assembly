# Integer expression fusion: is there a ceiling worth building for?

A **decode-time integer expression fold** would take a basic block whose interior is a chain of
full-width 32-bit integer ops, build one dataflow expression tree out of it, and emit a *single*
threaded-code op for the whole run: intermediates live in wasm locals, and only registers that are
live out get written back to the register file at block exit. It removes one `$next` dispatch per
folded op and one register-file round trip per intermediate.

`tools/bench-loops.js` already prices those primitives: **a dispatch is ~8ns and a block transfer
adds ~9ns on top of it**. So the whole question is *what share of retired ops sit inside such a
run*. If it is small, the fold is not worth building. `tools/expr-fold-census.js` measures that
share.

## What the tool measures

Input is a hot-block dump from a real run:

```
node test/run.js --app=ID --quiet-api --max-batches=999999 --max-seconds=N \
     --handler-hist --handler-hist-thread=0 --handler-hist-start=A --handler-hist-stop=B \
     --hot-block-dump=FILE
```

one line per distinct block, `0xADDR hits`. Every block address is mapped back to a module
(`lib/pe.js`), decoded from its entry with `tools/disasm.js` until a block terminator, and every
instruction is classified. Everything is weighted by the block's hit count, so

> **retired ops = Σ over blocks of `hits × ops_in_block`**

which is dispatches actually executed, not static instruction counts. DLL blocks are mapped with
the `DLL: NAME at 0xLOAD, ..., origBase=0x...` lines `test/run.js` prints unconditionally at load
(`--modules-from=RUNLOG`); blocks outside every known image are reported as an "outside exe" hit
share and not decoded.

Two derived numbers matter more than the raw share:

* **maximal foldable runs** — each run collapses to one dispatch, so *dispatches removed =
  foldable ops − runs*. That is the line the decision rests on.
* the same walk **with the may-alias rule off**, which brackets the answer between "no alias
  analysis at all" and "perfect alias analysis".

### FOLDABLE

Full-register 32-bit `mov` / `lea` / `add` / `sub` / `and` / `or` / `xor` / `imul` (2- and 3-operand)
/ `neg` / `not` / `shl` / `shr` / `sar` **by immediate**, plus `movzx` / `movsx` to a 32-bit
destination and `nop`. Register or `[mem]` operands both allowed; loads and stores may sit inside a
run, but their **order is preserved** — see `alias` below.

### BARRIERS (each ends the run; counted separately, weighted by retired ops)

| class | what ends the run |
|---|---|
| `partial-reg` | any 8/16-bit write (`al`, `ah`, `ax`, `mov [x], si`, `add byte [x], 1`) |
| `adc/sbb` | carry-chained arithmetic |
| `flags` | flag consumers: `setcc`, `cmovcc`, `lahf`/`sahf`, `pushf`/`popf`, `rcl`/`rcr` |
| `terminator-flags` | a `cmp`/`test` immediately feeding a conditional terminator — the *normal* shape, not a failure; the tree simply ends there |
| `shift-cl` | shifts by `cl` |
| `div` | `div`/`idiv` |
| `mul64` | `mul`, one-operand `imul` (64-bit result) |
| `call` / `ret` / `int` / `branch` / `branch-cc` | terminators |
| `string` | `movs`/`stos`/`lods`/`scas`/`cmps`, with or without `rep` |
| `stack` | `push`/`pop`/`enter`/`leave` — a dead temp is renamable but `esp` is live, so this is its own class |
| `segment` | `fs:`/`gs:` accesses and segment-register moves |
| `fpu/simd` | x87, MMX, SSE |
| `alias` | a load that follows a store **inside the same run**: an expression tree reorders freely, and nothing here proves the two do not overlap |
| `other` | `inc`/`dec` (partial flag update, CF preserved), `xchg`, `bswap`, `rol`/`ror`, `shld`/`shrd`, `bt*`, `cdq`/`cwde`, everything else |
| `undecoded` | the disassembler produced `db` — data in code, or a decode desync |

Per block the tool also reports the foldable op count, the longest maximal foldable run, the
number of distinct 32-bit registers written (the conservative live-out set: every register written
is assumed live out), and the load/store counts.

### Classifier verification

Hand-checked against `tools/disasm_fn.js` on the hottest block of the Quake II window,
`ref_soft.dll+0x12570` (67828 hits, 19 ops):

```
F 10012570  mov eax, edx        F 10012583  mov ebp, edx
F 10012572  add edx, ebx        F 10012585  mov [edi], eax
F 10012574  shr eax, 0x10       F 10012587  add edx, ebx
F 10012577  mov esi, edx        F 10012589  shr ebp, 0x10
F 10012579  add edx, ebx        F 1001258c  mov esi, edx
F 1001257b  and esi, 0xffff0000 F 1001258e  add edx, ebx
F 10012581  or eax, esi         F 10012590  and esi, 0xffff0000
                                F 10012596  or ebp, esi
                                F 10012598  mov [edi+0x4], ebp
                                F 1001259b  add edi, 0x8
  1001259e  dec ecx     [other]        — partial flag update, CF preserved
  1001259f  jnz short   [branch-cc]    — consumes ZF from the dec
```

17 of 19 foldable in one run, with the two barriers correctly identified: this is the span
texture-coordinate loop, and `dec`/`jnz` genuinely cannot be inside the tree. The bytes match
`disasm_fn.js` on the same file exactly, so the runtime→file VA arithmetic
(`va − loadAddr + origBase`) is right too.

## Per-app results

Measured 2026-09-10. All runs `--quiet-api --max-batches=999999 --max-seconds≤60`.

| app | window (what it is) | retired ops | foldable | ops in blocks with ≥4 foldable | run p50 / p90 | dispatches removed | top barrier |
|---|---|---|---|---|---|---|---|
| `quake2_demo` | b3000–3100, `+set vid_ref soft +map demo1`, world rendering | 18.64 M | **47.7 %** | 69.6 % | 3 / 9 | **28.8 %** | `fpu/simd` 20.3 % |
| `caesar3_demo` | b3500–3600, city simulating (verified by capture at b3450) | 29.55 M | **67.9 %** | 65.1 % | 3 / 4 | **36.3 %** | `alias` 19.9 % |
| `mw3` | b35–50, **startup only** — see caveat | 103.83 M | **84.1 %** | 98.7 % | 20 / 20 | **70.1 %** | `partial-reg` 9.8 % |
| `heaven7` | b400–500, **precalc loop, not the render loop** — see caveat | 4.13 M | **12.4 %** | 0.0 % | 0 / 1 | **3.0 %** | `branch-cc` 24.1 % |

Alias-relaxed run lengths (perfect alias analysis, the other bracket): quake2 p50 5 / p90 17;
caesar3 p50 5 / p90 **465**; mw3 unchanged at 20; heaven7 unchanged.

Outside-image hit share: quake2 2.4 % (only `gamex86.dll`, which is not on disk in this install),
caesar3 0 %, mw3 0 %, heaven7 0 %. Quake II's window is 97.6 % inside `ref_soft.dll` and `quake2.exe`
once the DLL bases are supplied — **without** `--modules-from` it reads 86.3 % outside and the
foldable share collapses to a meaningless 26 %, so always supply the module map.

### Caveats on two of the four windows

* **`mw3` never reaches gameplay headless inside 60 s.** At `--batch-size=200000` it managed 96
  batches in 60 s; the documented cockpit route needs batch ~888. The window measured (b35–50) is
  its startup/transition screen, and **98 % of it is two blocks** — `0x526f54` and `0x527075`, a
  16-bit-per-pixel software alpha blend. So 84 % is one loop's number, not the app's.
* **`heaven7` never reaches its render loop headless either.** After the setup dialog it sits in a
  recursive tracer (`cmp byte [edi],0 / jz`, `sub edi,ebx ×2 / call esi`) for the whole 55 s run —
  four PNG captures at b2000/5000/10000/13500 are byte-identical. Its blocks are 1–3 ops with a
  `call` or `ret` at the end, which is why nothing folds.
* `caesar3_demo` did reach a live city (839 KB capture at b3450) within 60 s. `quake2_demo` was
  rendering the demo1 world (125 KB capture at b4000).

### Eyeballed top blocks

**quake2 `ref_soft.dll+0x12570`** — 17/19 foldable, run 17, 6 live-outs. Ideal case; the whole
interior is one tree. Its neighbour `+0x11e94` (63 ops, 28 foldable, run **5**) is the opposite: the
span mapper's `sbb ecx,ecx / adc esi,[base+ecx*4]` carry trick plus `mov al,[esi]` byte stores chop
the block into 5-op fragments. Those two blocks are the same routine and land on opposite sides of
the barrier list.

**caesar3 `0x41d7a0` / `0x41cf0f`** — 470 and 467 ops, ~465 foldable, but run **3**. These are fully
unrolled row copies, `mov eax,[esi+N]` / `mov [edi+edx+M],eax` repeated 225 times. Every load after
a store trips the may-alias rule, so the conservative run is 3 and the alias-relaxed run is 465.
This single shape *is* caesar3's 19.9 % `alias` barrier, and it is also exactly what the existing
`COPY_RUN` / `rect_run` superops already target — so most of caesar3's headroom is not new
territory.

**caesar3 `0x40fa38`** — 7 ops, 5 foldable, run 4: the RLE token decoder (`xor eax,eax` /
`mov al,[esi+1]` / `add edi,eax ×2` / `add esi,2` / `sub ecx,eax` / `jmp`). One 8-bit load in the
middle costs two ops of run length.

**mw3 `0x526f54`** — 42 ops, 36 foldable, run 20, 6 live-outs. A 16-bit blend: three `mov dx,[..]`
partial loads are the only barriers in an otherwise pure `and`/`add`/`shr`/`lea` tree.

**heaven7 `0x409cb6`** — 2 ops (`cmp byte [edi],0` / `jz`), 502072 hits. Nothing to fold.

## Verdict

**The ceiling is real but modest, and it is smaller than the raw "foldable share" suggests.** On the
two windows that are genuinely rendering, 48 % (quake2) and 68 % (caesar3) of retired ops are
foldable, but the mean run length is only **2.5 and 2.15** — so the dispatches actually removed are
**28.8 % and 36.3 %** of retired ops, and every removed dispatch still costs a live-out writeback at
run exit (the conservative live-out counts here are 2–6 registers per block). At ~8 ns a dispatch
that is an upper bound of roughly a quarter to a third of interpreter dispatch time before any
writeback cost is subtracted, and a large slice of caesar3's share is the unrolled-copy shape the
existing `COPY_RUN`/`rect_run` folds already cover. The two headline numbers on either side —
mw3's 84 % and heaven7's 12 % — are both single-loop artifacts of windows that never reached the
intended workload, and should not be read as an app characterisation. Against that, the barrier
histogram says where a *cheaper* investment lies: `partial-reg` alone is 6 % / 4.6 % / 9.8 % of
retired ops across the three decodable apps, `adc/sbb` is 4.9 % of quake2, and caesar3's 19.9 %
`alias` would fall out of a disjoint-base check on a single addressing pattern. **Recommendation:
do not build the general decode-time expression tree yet.** The measured headroom does not clearly
beat what a narrower fold — same-base disjointness for the copy shape, and full-width handling of
16-bit-into-32-bit loads — would buy for far less machinery, and this census is the tool to re-run
against any such narrower proposal.

## Things the classifier cannot do

* **Packed executables.** heaven7 is UPX-packed: `UPX0` has `Raw=0`, so the code that actually runs
  exists nowhere on disk and every block read as `undecodable`. The workaround is
  `--mem=FILE`, which parses a `--input=N:dump-mem:0xADDR:LEN` hexdump as a code image; it is how
  the heaven7 row above was produced, but it only covers the range you thought to dump.
* **Self-modifying and runtime-generated code** in general — same failure mode, same workaround.
* **A DLL that is not on disk.** Quake II's `gamex86.dll` is missing from this install, so 2.4 % of
  its hits stay in the outside-image bucket.
* **Block length is capped** (`--max-ops`, default 256). caesar3's unrolled copies are ~470 ops and
  are silently truncated at the default; the report now names the truncated hit share, and the
  numbers above use `--max-ops=4096`. At 256 caesar3 reads 62.5 % foldable instead of 67.9 %.
* **Live-out is approximated conservatively** as "every 32-bit register written in the block",
  with no cross-block liveness. Real liveness would be smaller, so the writeback cost above is an
  over-estimate — in the fold's favour.
* **`--handler-hist-thread=0` only**, so a multithreaded app's worker blocks are invisible.
* Data-in-code produces `undecoded` (0.1 % on quake2, 0 elsewhere), which is small enough to ignore
  here but would matter on a Borland binary.

## Reproducing

```bash
S=/tmp/fold
# quake2 — soft renderer so the work stays in the interpreter, not behind gpu_gl_call
node test/run.js --app=quake2_demo --args='+set vid_ref soft +map demo1' --quiet-api --no-close \
  --screen=800x600 --batch-size=20000 --max-batches=999999 --max-seconds=55 \
  --handler-hist --handler-hist-thread=0 --handler-hist-start=3000 --handler-hist-stop=3100 \
  --hot-block-dump=$S/q2-hot.txt > $S/q2-run.log 2>&1
node tools/expr-fold-census.js --dump=$S/q2-hot.txt \
  --exe=test/binaries/candidates/quake-2-demo-installer/installed-extracted/Install/Data/quake2.exe \
  --modules-from=$S/q2-run.log --max-ops=4096 --label=quake2_demo --json=$S/q2.json
```

`--modules-from` reads the run log's own `DLL:` lines, so the emulator's load addresses and the
census always agree. Add `--module-dir=` for images that do not sit beside the exe.
