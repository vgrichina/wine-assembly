# Calc.exe Execution Analysis

## Current Status (2026-04-02)

### Summary
Calc.exe now crashes on `GetSubMenu` at batch 1 (EIP=0x01001e2f) before
reaching the bignum initialization. This is a regression from upstream changes
(not this session) — `GetSubMenu` is an unimplemented crash stub. Calc uses
`GetMessageA` for its message pump (not `PeekMessageA`).

Previous blocker: Newton iteration loop at `0x0100ced9` does NOT converge — numbers grow without bound (digit counts reaching 122+), consuming 256MB+ before OOM. The convergence check at `0x0100cf4b` is never reached because a single BigNum_Power call takes hundreds of millions of instructions.

### Key findings (2026-04-01 session 2)
- **BigNum_Multiply is CORRECT** — `test/test-bignum-mul.js` passes all 17 tests including 5×5 digit, max-value carry propagation, and sign handling
- **SHRD is correct** — unit tested `SHRD EAX, EDX, 31` with multiple values, all pass
- **The Newton loop never reaches its convergence check** — the intermediate BigNum_Power call produces numbers so large that a single multiply call runs for millions of steps, growing the heap unboundedly
- **Digit counts observed**: 6→25→92→122 (sampled from [ebp-0xc] during multiply inner loop). For 42-digit precision these should max at ~10
- **This is NOT a threading issue** — calc.exe never calls CreateThread/WaitForSingleObject
- **The bug is upstream of multiply** — the Newton iteration logic at `0x0100ced9` feeds wrong/growing inputs to BigNum_Power, likely due to a bug in an instruction used in the convergence computation or the number construction between iterations
- **Gemini report flagged**: ADC/SBB flag_res corruption, POP [mem] stale ESP, SETcc memory clobber — these need investigation as potential root causes

### What calc.exe is computing at startup
Win98 calc.exe uses an arbitrary-precision math library (base 2^31 digits, schoolbook O(n²) multiply). At startup it initializes precision tables:

1. **Set precision** = 42 decimal digits (32 displayed + 1 + 9 guard digits)
   - `[0x1013ebc]` = 33 (set at `0x010081d9`) then += 9 (at `0x01008556`)
   - `[0x1013eb0]` = 9 (base-2^31 digits per decimal group)
2. **Newton iteration loop** at `0x0100ced9` — computes reciprocal or log tables
   - Each iteration: calls `0x100b1f6` (BigNum_Square?) → `BigNum_Power` (`0x0101147e`) → `BigNum_Multiply` (`0x01011506`)
   - Loop exits when `effective_digits × 9 > 42` (check at `0x0100cf4b-0x0100cf52`) OR `fInitialized != 0`
   - Neither condition ever triggers — numbers grow instead of converging

### Crash analysis
- **Crash at 185.5M steps**: prevEip=`0x01010cf6` → eip=`0x7efef499` (wild)
- `0x01010cf0` is `call 0x100d0d4` (5-byte E8 instruction), return address should be `0x01010cf5`
- `0x01010cf5` is `85 C0` (test eax,eax), `0x01010cf7` is `75 11` (jnz)
- But prevEip=`0x01010cf6` — ONE BYTE INTO the `test` instruction!
- This means EIP arrived at `0x01010cf6` somehow (wrong return address, stack corruption, or decoder bug producing wrong block-end EIP)
- The first Newton loop WORKS (converges in ~10 iterations, ~100K steps)
- There are TWO Newton loops with identical structure but different function call targets
- The crash happens 185M steps in, during the SECOND phase (power-of-10 table building)
- Digit counts grow to 289+ (expected max ~10 for 42-digit precision)

### Next steps to investigate
1. **Why does EIP land at 0x01010cf6 instead of 0x01010cf5?** — Check if the `call` at `0x01010cf0` pushes the wrong return address, or if the stack gets corrupted during the called function
2. **Check `0x100d0d4` function** — it uses `rep movsd/movsb`, `call`s, and `rep movsb` again. If REP MOVS clobbers something or the direction flag is wrong, stack corruption could result
3. **Check REP MOVSD/MOVSB implementation** — if the direction flag (DF) is wrong or ESI/EDI aren't updated correctly, memory corruption could cause the return address to be overwritten
4. **Test with --trace at batch ~1854** — use `--batch-size=100000` to narrow down the exact crash point

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
