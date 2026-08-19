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
