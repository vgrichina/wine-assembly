# Calc.exe Execution Analysis

## Current Status (2026-04-01)

### Summary
Calc.exe boots through DLL init, CRT init, window creation, and enters its bignum library initialization. It gets stuck in the bignum init — after 120M emulated x86 instructions (~60 seconds in Node.js) it's still computing. Previously calc.exe worked and started fast, so something may still be wrong despite all tested instructions being correct.

### What calc.exe is computing at startup
Win98 calc.exe uses an arbitrary-precision math library (base 2^31 digits, schoolbook O(n²) multiply). At startup it initializes precision tables:

1. **Set precision** = 42 decimal digits (32 displayed + 1 + 9 guard digits)
   - `[0x1013ebc]` = 33 (set at `0x010081d9`) then += 9 (at `0x01008556`)
   - `[0x1013eb0]` = 9 (base-2^31 digits per decimal group)
2. **Newton iteration loop** at `0x0100ced9` — appears to compute reciprocal or log tables
   - Each iteration: calls `BigNum_Power` (`0x0101147e`) → `BigNum_Multiply` (`0x01011506`)
   - Loop exits when `effective_digits × 9 > 42` (check at `0x0100cf4b-0x0100cf52`)
   - Should converge in ~5-6 Newton iterations (quadratic convergence)
3. **Power-of-10 table** at `0x010074c4` — computes 10^N via binary exponentiation
   - Outer loop: iterates over exponent dwords (count = min(precision+1, digit_count))
   - Inner loop: scans 30 bits per dword, squaring accumulator each time

### The speed problem
After 120M emulated steps (~60 seconds), EIP is still in the multiply inner loop (`0x01011564-0x0101162b`). The multiply digit counts grow each iteration (observed: 1→9→35→65 digits at batches 2/50/100/150 with 100K steps/batch).

**Open question: Why does it take >120M instructions for only 42 digits?**
- 42 decimal digits ≈ 5 dwords in base 2^31
- Newton iteration should need ~5-6 iterations
- Each multiply of 5×5 digit numbers = 25 inner iterations × ~50 instructions = ~1250 instructions
- Expected total: ~50K-500K instructions for the entire init
- **Actual: >120M instructions — that's 240x-2400x more than expected**

### Doubts and open questions
1. **Calc previously worked and started fast** — after fixing the imul bug, calc completed bignum init in ~1M blocks and the UI appeared. What changed? The main difference this session was adding MSVCRT.dll loading. Could MSVCRT's CRT init be triggering a different (longer) code path?
2. **Why are digit counts growing to 65+?** — If computing 10^42, the number has ~5 digits in base 2^31. The power-by-squaring needs ~6 levels. Digit counts should max at ~10. Yet we see 65 digits at batch 150 — this implies numbers with ~2000 bits. What is being computed that requires 2000-bit intermediates?
3. **The power function's loop count** — At `0x01007499`, EDI = min(`[0x1013ebc]+1`, `[esi+4]`). If the exponent bignum's digit count is small (2), EDI should be 2, not 43. But we haven't confirmed the actual digit count of the exponent struct at that point.
4. **Is there a second, different code path?** — The stack trace showed the multiply being called from `0x0100cf14` → `0x0101147e` → `0x0101147e` (BigNum_Power), NOT from the power-of-10 table builder at `0x010074c4`. The Newton loop at `0x0100ced9` might be a completely different, more expensive computation (e.g., computing ln(10) or π to 42 digits).
5. **Could an instruction bug cause wrong convergence?** — All 33 tested ops pass unit tests (MUL, SHRD, SHLD, ADC, ADD+ADC, INC/DEC CF preservation, SAHF/LAHF). But the test suite only tests individual instructions, not complex interactions. A subtle flag issue in a rarely-hit path could cause Newton iteration to converge slowly or not at all.
6. **The `imul eax, [ebx]` at `0x01011542`** — This computes the "sign" product when entering BigNum_Multiply. If `imul r32, [mem]` has a subtle bug for some operand combinations (e.g., sign extension), it could corrupt the sign field and cause incorrect convergence checks.

### What's known to work
- DllMain completes (EAX=1)
- CRT globals patched correctly
- CreateWindow succeeds ("CalcMsgPumpWnd")
- The bignum multiply loop runs without crashing (after DLL_TABLE fix)
- All 33 individual instruction tests pass
- Heap allocations proceed normally (bump allocator)

## Fixes This Session
- **MSVCRT.dll auto-loading** — CLI + web host detect required DLLs from import table
- **DLL_TABLE/hash table overlap** — DLL_TABLE moved from 0x1363000 to 0x1366000 (16KB reserved for API hash table, supports up to 2048 APIs)
- **SAHF/LAHF** — opcodes 0x9E/0x9F implemented (handlers 212/213), needed for MSVCRT FPU comparison idiom
- **GetSystemTimeAsFileTime** — returns fixed ~2000-01-01 timestamp, was crash stub
- **Web stepsPerSlice** — increased from 10K to 500K
- **x86 test suite** — `test/test-x86-ops.js` with 33 tests

## Previously Fixed
- `imul r,[mem]` clobbered dst (decoded as load+square)
- INC/DEC cleared CF (added saved_cf)
- ADC/SBB carry overflow
- MUL/IMUL flags
- Button clicks (resource parser, GetMessageA routing, IsChild)
- Arithmetic (`_strrev`, `strchr`, ADC/SBB threading)

## Key Memory Addresses

| Address | Name | Value | Notes |
|---------|------|-------|-------|
| 0x1013ebc | nPrecision | 42 | 32 + 1 + 9 guard digits |
| 0x1013eb0 | nDigitsPerGroup | 9 | ~digits per base-2^31 word |
| 0x1013eb8 | fInitialized? | 0 | Checked at 0x10074c4 to skip power table if already done |
| 0x101301c | nBase | 10 | Number base (decimal) |
| 0x1013014 | nDisplayDigits | 32 | Displayed precision |
| 0x1013020 | ? | 32 | Related to display precision |
| 0x1013c74 | nPrecisionRaw | 32 | Before adding guard digits |

## Execution Flow

### Phase 1: DLL + CRT Init ✓
```
load_dll(msvcrt.dll) → DllMain returns 1 → CRT globals patched
__set_app_type → _initterm → GetStartupInfoA → GetCommandLineA
```

### Phase 2: Window + Strings ✓ (~500K steps)
```
RegisterClassExA("CalcMsgPumpWnd") → CreateWindowExA → LoadStringA ×80
```

### Phase 3: Precision Init ✓ (~1-2M steps)
```
0x01004bcd: compute precision = 32
0x01004bdf: call init(base=10, precision=33)
0x010081d9: [0x1013ebc] = 33
0x01008556: [0x1013ebc] += 9 → 42
0x01008200: [0x1013eb0] = 9
```

### Phase 4: Bignum Library Init ← STUCK HERE (>120M steps)
```
0x0100ced9: Newton iteration loop
  0x0100cf14: call BigNum_Power(0x0101147e)
    → BigNum_Multiply(0x01011506)
      → inner loop at 0x01011564 (MUL + ADC + SHRD per digit pair)
  0x0100cf4b: check if effective_digits × 9 > 42
  0x0100cf60: if not done, loop back to 0x0100ced9
```

### Phase 5: NOT REACHED — Main Window
```
CreateDialogParam("SciCalc") → ShowWindow → GetMessageA loop
```

## Code Map
```
0x010119E0  WinMain (entry point)
0x01004BCD  SetPrecision (computes nPrecision=42)
0x010081BB  InitBigNumEngine(base, precision)
0x01008556  Add guard digits to precision
0x0100CED9  Newton iteration loop (main bottleneck)
0x0100CF14  BigNum_Power call within Newton loop
0x0101147E  BigNum_Power (recursive squaring)
0x01011506  BigNum_Multiply (O(n²) schoolbook, base 2^31)
0x01011564  BigNum_Multiply inner loop (MUL+ADC+SHRD per digit pair)
0x01007465  Power-of-10 table builder (binary exponentiation)
0x01007AF5  ConvertToBase (integer → base-N digit array)
0x01010B08  BigNum_Create (alloc + init)
0x0100B37B  BigNum_Copy/Normalize?
0x01007349  LocalFree wrapper
0x0100592A  SciCalc WndProc
```
