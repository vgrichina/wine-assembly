# Calc.exe Execution Analysis

## Current Status (2026-04-01)

### Fixed This Session
- **MSVCRT.dll not loading** — calc.exe imports MSVCRT.dll but neither CLI nor web host loaded it. Added auto-DLL detection to both `test/run.js` and `host/index.html` using `detectRequiredDlls()`.
- **DLL_TABLE/hash table overlap** — DLL_TABLE at 0x1363000 overlapped API hash table entries 512+ (hash table ends at 0x1363638). Corrupted hash lookups caused `GetSystemTimeAsFileTime` and other APIs to hit `crash_unimplemented` even though handlers existed. Moved DLL_TABLE to 0x1366000 with 16KB reserved for hash table (up to 2048 APIs).
- **SAHF/LAHF not implemented** — Opcode 0x9E (SAHF) used in MSVCRT's FPU comparison idiom (`fcompp; fnstsw ax; sahf; jbe`) caused infinite loop at EIP=0x1042c53. Added decoder entries and handlers (opcodes 212/213).
- **GetSystemTimeAsFileTime unimplemented** — MSVCRT DllMain needs this for CRT init. Returns fixed timestamp (~2000-01-01).
- **DllMain now completes** — Returns EAX=0x1 (success). CRT globals patched correctly.

### Previously Fixed
- **imul r,[mem] clobbered dst** — 0F AF decoded as load+square instead of multiply. Calc bignum init now completes in ~1M blocks (was stuck at 100M+).
- **INC/DEC cleared CF** — added saved_cf; bignum adc chains now preserve carry across inc counters.
- **ADC/SBB carry overflow** — b+cf_in wrap (0xFFFFFFFF+1) now forces CF=1.
- **MUL/IMUL missing flags** — CF=OF set when upper half non-zero (flag_op=6).
- **Button clicks not working** — Resource parser key mismatch, GetMessageA hwnd routing, IsChild/SendMessage fixes.
- **Arithmetic operations** — `_strrev`, `strchr` implemented; ADC/SBB carry flag threading fixed.

### Open Issues
1. **Bignum init very slow** — CRT init completes but calc's power-of-10 precomputation (O(n² × log P)) runs ~100M+ x86 instructions. With stepsPerSlice=500K in browser, takes 30-60+ seconds. Heap grows ~5KB per 1M instructions, may OOB before completing.
2. **Re-add heap free-list** — reverted to bump allocator; bignum init allocs+frees heavily and will OOM on long runs without free-list.
3. **Web stepsPerSlice increased** — bumped from 10K to 500K to help calc init survive.

## Overview
Win98 calc.exe (image_base=0x01000000, entry=0x010119e0). Requires MSVCRT.dll (auto-loaded from `test/binaries/dlls/`). DllMain and CRT init now complete. Gets stuck in bignum power-of-10 precomputation — computationally expensive but NOT an infinite loop.

## Execution Phases

### Phase 1: DLL Init
```
load_dll(msvcrt.dll) → patchExeImports → DllMain
  DllMain calls: GetSystemTimeAsFileTime, QueryPerformanceCounter, GetCurrentProcessId,
  GetCurrentThreadId, GetTickCount, GetEnvironmentStringsW, WideCharToMultiByte, etc.
  DllMain returns 1 (success)
  Post-patch: __p__wcmdln, __p__acmdln, __p__wenviron, __p__environ, __p___winitenv, __p___initenv
```

### Phase 2: CRT Init (blocks 0–100, EIP ~0x010119e0–0x01001650)
```
__set_app_type → __p__fmode → __p__commode → _controlfp → _initterm
→ __getmainargs → _initterm → GetStartupInfoA → GetModuleHandleA
→ _EH_prolog → GetCommandLineA → CharNextA x7
```
Standard MSVC runtime startup. Parses command line, sets up CRT globals.

### Phase 3: Window Class Registration (blocks ~100)
```
LoadIconA → LoadCursorA → GetSysColorBrush → RegisterClassExA
```
Registers the "CalcMsgPumpWnd" window class.

### Phase 4: Hidden Helper Window (block ~400)
```
CreateWindowExA("CalcMsgPumpWnd", CW_USEDEFAULT)
```
Creates the message pump helper window (hwnd=0x10001).

### Phase 5: Bignum Library Init — SLOW (blocks 500+)
**Address range: 0x01010B00–0x01011700 (bignum math library)**

The power-of-10 precomputation loop runs at 0x01011564–0x0101167B. Inner multiply is O(n²), outer loop computes successive powers via squaring. Each iteration allocates new arrays via `LocalAlloc` → `HeapAlloc` and frees old ones via `LocalFree`.

Heap growth rate: ~5KB per 1M emulated instructions. Guest heap starts at 0xF12000, guest stack at 0x1E00000 — ~15MB available. May need 200-500M instructions to complete.

### Phase 6: Main Window Creation (reached after bignum init)
```
CreateWindowExA("SciCalc", "Calculator", ...) → CreateDialog → ShowWindow
→ LoadMenuA → SetMenu → GetMessageA → DispatchMessageA (message loop)
```

## Options to Speed Up

1. **Increase stepsPerSlice** — done (10K → 500K), helps but still slow
2. **Skip bignum init** — detect init function and return early (UI works, math shows "0")
3. **Native bignum** — replace hot multiply loop with WASM intrinsic
4. **Patch calc.exe** — NOP out the precompute loop in binary
5. **Block caching** — JIT cache helps since same basic blocks repeat

## Address-to-Function Map

```
0x010119E0  WinMain (entry point)
0x01001620  LoadStringTable (loads 80 strings)
0x01008200  InitCalcApp (creates helper window, starts bignum init)
0x01007AF5  InitPrecisionTable (bignum library setup)
0x01007B20  ComputePowerTable (iterative squaring loop)
0x01011564  BigNum_Multiply_Inner (core loop, shrd+mul+adc)
0x0101147E  BigNum_Power (recursive power computation)
0x01011506  BigNum_Multiply (core multiply, O(n*m))
0x01010B08  BigNum_Create (alloc + init struct)
0x01010C00  BigNum_Add
0x01010C40  BigNum_Sub
0x01010C70  BigNum_ShiftRight
0x0100EEE5  BigNum_Divide (uses _CxxThrowException on div-by-zero)
0x010078E2  BigNum_ToString (_strrev + formatting)
0x01007349  LocalFree wrapper (called after each multiply)
0x01007F42  BigNum_Cleanup
0x01009549  BigNum_Compare
0x0100592A  SciCalc WndProc (dialog message handler)
```
