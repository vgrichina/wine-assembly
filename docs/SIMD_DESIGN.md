# SIMD Support Design (SSE/MMX)

## 1. Overview
Transitioning the emulator to support SIMD involves mapping x86 vector registers to WebAssembly `v128` types and handling the architectural aliasing between MMX and the FPU.

## 2. Register Mapping

### 2.1 SSE (XMM0-XMM7)
*   **Storage:** 8 new global variables of type `v128` in `src/01-header.wat`.
*   **Wasm Type:** `v128` is a natural fit for 128-bit SSE.
*   **Alignment:** Wasm `v128.load/store` instructions are always unaligned-safe, matching x86 `MOVUPS` behavior. `MOVAPS` will be a logical alias but can check for 16-byte alignment for strictness.

### 2.2 MMX (MM0-MM7)
*   **Aliasing:** MMX registers are aliased to the 64-bit mantissas of the FPU stack (`st0-st7`).
*   **Storage:** Shared physical storage with the FPU. MMX instructions will use `i64` operations or the low 64 bits of a `v128`.
*   **State Switch:** Any MMX instruction marks all FPU tags as "Valid" (`0xFF`). `EMMS` clears them to "Empty" (`0x00`).

## 3. Instruction Mapping Table

| x86 Opcode | Description | WASM SIMD Equivalent |
| :--- | :--- | :--- |
| `ADDPD / ADDPS` | Packed Double/Single Float Add | `f64x2.add / f32x4.add` |
| `PADD[B/W/D]` | Packed Integer Add | `i8x16.add / i16x8.add / i32x4.add` |
| `ANDPS / ORPS` | Bitwise Logic | `v128.and / v128.or` |
| `MOV[A/U]PS` | Move Aligned/Unaligned | `v128.load / v128.store` |

## 4. Implementation Phases

### Phase 1: Infrastructure
*   Enable `simd` proposal in build tools (e.g., `wat2wasm --enable-simd`).
*   Add `XMM` globals to the header.
*   Add `$th_sse_reg` and `$th_sse_mem` generic thread handlers.

### Phase 2: Integer MMX
*   Map basic `PADD`, `PSUB`, `PXOR`.
*   Crucial for legacy multimedia decoders.

### Phase 3: Floating Point SSE
*   Implement `ADDPS`, `MULPS`, etc.
*   Necessary for modern 3D math and audio processing (DirectSound/Direct3D).

## 5. Performance Considerations
*   **Lazy State:** We only sync FPU Condition Codes if a non-SIMD instruction (like `FNSTSW`) follows a math block.
*   **Thread Ops:** SSE operations will be multi-word in the thread buffer to handle the variety of packed vs. scalar variants.

## 6. What MMX Actually Buys — Measured

**Headline: 1.2x–1.5x on real applications, not the 7x the microbenchmark shows.**

`tools/mmx-bench.js` reports 7.24x wall / 10.9x fewer x86 instructions on a
saturating byte blend. That is the vector loop in isolation. A real frame also
spends time on file I/O, palette work and the message pump, none of which MMX
touches, so Amdahl caps the app-level win far below the kernel-level one. When
quoting a number for what MMX support is worth, quote this section, not the
bench.

| App | Workload | Ratio |
|---|---|---|
| Jazz Jackrabbit 2 | `logo.j2v` intro video decoder | **1.53x** |
| StarCraft (shareware) | SMACKW32 Smacker decoder | **1.20x** |

```
jazz2      --exe=test/binaries/candidates/jazz-jackrabbit-2-demo-installer/installed/jazz2.exe \
           --vfs-include='*.j2*,*.lst,*.txt'
           20000 batches: 2160 vs 1409 frames   (frame = SelectPalette)
           2.21M MMX instructions retired vs 0

starcraft  --exe=test/binaries/candidates/starcraft-shareware/installed/starcraft.exe \
           --vfs-include='*.dll,*.mpq,*.snp'
            5000 batches:   93 vs   85 frames   (frame = IDirectDrawSurface_Unlock)
            9000 batches:  234 vs  203 frames
            marginal:      141 vs  118 frames -> 1.20x
           11.2M MMX instructions retired vs 0
```

### 6.1 Why only these two apps

`--no-mmx` flips only the CPUID leaf-1 EDX bit 23; the MMX handlers stay live.
So a ratio requires a guest that picks its own path at runtime, and most of the
corpus does not. `tools/mmx-census.js` finds the ones that do. Two binaries look
dual-path and are not — AVS and `in_mod.dll` each compute a feature flag and then
run MMX regardless (AVS 2.6.1 is the MMX-only build and simply refuses to start
with the bit off). jazz2 is the real shape:

```
00490e6c  test eax, 0x800000            ; EDX from CPUID leaf 1
00490e73  mov byte [0x4f7d78], 1        ; the MMX flag ...
00452bb4  mov al, [0x4f7d78]            ; ... read at 14 sites
00452bbb  jz 0x452c83                   ; scalar fallback
00452bc4  movq mm6, [0x4c4698]          ; vector leaf
```

### 6.2 Measuring one of these without fooling yourself

Four traps, each of which produced a wrong number before the ones above:

*   **Never use wall clock.** This box routinely sits at load 5–40 with other
    agent sessions running. Batches are fixed-size dispatch budgets, so
    *frames per fixed batch count* is the load-independent equivalent.
*   **Never use API-call count as a speed proxy.** The two paths make different
    numbers of API calls per frame. On jazz2 the *slower* config showed a
    *higher* rate — 1.68 calls/batch vs 1.34. Count frame presents.
*   **Take two budgets and use the marginal rate.** Startup and asset loading
    are identical work both ways and dilute a single sample: StarCraft reads
    1.09x at 5000 batches, 1.15x at 9000, and 1.20x on the difference.
*   **Confirm the app is CPU-bound first.** If it is waiting on its frame clock
    the ratio measures nothing. `--time-scale=10` left StarCraft at exactly 234
    frames, which proves it was not waiting. A single sample can also land
    mid-transient and look like a hang — jazz2's API count went flat between
    batch 4000 and 8000, and `--trace-sched=500` showed it churning inside
    *one* scalar frame decode the whole time.

### 6.3 Remaining candidates

From `tools/mmx-census.js`, by biggest cluster: ScummVM (1062), VirtualDub
(1045, dies in its MSVC runtime startup), MilkDrop `vis_milk.dll` (722, needs
Direct3D 8 — the project has DirectDraw, D3D IM v2/3/7, D3DRM and D3D9, but no
D3D8), `msvbvm60.dll` (522), TWorld's `SDL.dll` (200). Caesar III ships the same
SMACKW32 as StarCraft, so it should behave like it.

Trust the tool's density column, not its raw count: RollerCoaster Tycoon scores
588 "MMX instructions" and retires **zero** at runtime, because they are 249
scattered linear-sweep misdecodes at 2.4 instructions per cluster. Under 4 is
noise.
