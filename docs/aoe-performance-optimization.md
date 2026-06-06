# AoE Performance Optimization Notes

## Current Measurement

Latest AoE campaign gameplay profile:

- Scenario: Bronze Age Art of War campaign, 10 seconds in-game.
- Actions: box-select starting units, issue three move orders, keep mouse active.
- Profile output: `/private/tmp/aoe-web-profile.json`.
- Raw CPU profile, when enabled: `/private/tmp/aoe-cpu-profile.json`.

Timing from the gameplay window:

```text
profile elapsed:       10011.9 ms
main.runSlice:          6580.6 ms
wrapped host imports:    362.0 ms
guest/interpreter:      6218.6 ms
present fps:              21.5
```

The bottleneck is the WAT x86 interpreter, not canvas repaint and not mostly DIB conversion.

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

Risk:

- More handler table entries.
- Need careful coverage for absolute/SIB/no-base forms.

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

Handler-level data tells what kind of emulator work is hot, not which AoE guest routines are hot.

Next measurements:

- Enable EIP/block hit counters for hot game ranges.
- Correlate hot guest blocks with handler sequences.
- Use that to decide whether local block compilation would pay off.

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

1. Add specialized Jcc handlers and measure.
2. Add `cmp/test -> jcc` fusions and measure.
3. Add `compute_ea_sib -> load/store/jmp` fusions and measure.
4. Add stack fast paths for push/pop and measure.
5. Add register specialization or `br_table` helpers if get/set reg remains hot.
6. Explore triple histograms once pair-driven wins flatten out.
