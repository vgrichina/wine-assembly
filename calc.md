# Calc.exe Execution Analysis

## Current Status (2026-04-01)

### Root Cause Found: Bignum init loop count bug
**`[0x1013ebc]` = 42** (decimal precision) is being used as the outer loop count in the power-of-10 table computation at `0x010074c4`. Each outer iteration does 30 inner squarings. With 42+1=43 outer iterations × 30 = **1,290 squarings**, the numbers grow to astronomical size (2^1290 digits). This should be ~2-5 iterations based on exponent digit count in base 2^31.

**Likely cause**: The power function at `0x01007465` receives the wrong parameter — the decimal precision (42) instead of the exponent's digit count in base 2^31 (~2). The conversion function at `0x01007af5` converts values to base 2^31, but the outer loop counter at `0x01007499` reads `[0x1013ebc]` directly (the raw precision) instead of the converted digit count.

**Next step**: Trace the exact arguments passed to `0x01007465` and verify the conversion at `0x01007af5` produces the right digit count. The bug is likely upstream — either in how the precision is passed or in how the exponent is represented.

### Fixed This Session
- **MSVCRT.dll not loading** — auto-DLL detection added to CLI and web host
- **DLL_TABLE/hash table overlap** — moved DLL_TABLE to 0x1366000 (16KB hash table space)
- **SAHF/LAHF not implemented** — added decoder + handlers (opcodes 212/213)
- **GetSystemTimeAsFileTime** — implemented (was crash stub)
- **DllMain now completes** — returns EAX=0x1 (success)
- **x86 op test suite** — 33 tests for MUL, SHRD, ADC, INC/DEC CF preservation, SAHF/LAHF

### Previously Fixed
- imul r,[mem], INC/DEC CF, ADC/SBB carry, MUL flags, button clicks, arithmetic ops

## Key Memory Addresses

| Address | Name | Value | Notes |
|---------|------|-------|-------|
| 0x1013ebc | nPrecision | 42 | Decimal precision (should be ~32+10 guard) |
| 0x1013eb8 | ? | 0 | Checked at 0x10074c4 |
| 0x1013eb0 | nDigitsBase | ? | Set at 0x1008200, derived from precision |

## Execution Flow

### DLL + CRT Init → OK
MSVCRT.dll loads, DllMain returns 1, CRT globals patched.

### Power-of-10 Table Init → STUCK
```
0x010081d9: [0x1013ebc] = 42 (precision)
0x01007465: Power function called with bignum exponent + base
0x01007499: edi = [0x1013ebc] + 1 = 43 (OUTER LOOP COUNT)
0x010074c4: for each dword in exponent (43 times):
0x010074d4:   for each bit (30 times): square the accumulator
            Total: 1290 squarings → numbers grow to 2^1290 base-2^31 digits
            → OOB crash after ~180M emulated instructions
```

### The Power-of-10 Conversion Loop (0x01007af5)
```c
// Converts value to base b, stores digits
int convert(int value, int base) {
    int digits = 0;
    while (value != 0) {
        digit[digits++] = value % base;
        value /= base;
    }
    return digits;
}
```
For value=0x80000000, base=0x80000000: produces 2 digits (0, 1).

### The Power Function (0x01007465)
```c
void power(bignum *base_num, bignum *result, int precision) {
    bignum x = convert(0, precision);       // zero
    bignum y = convert(0x80000000, precision); // the base in digits
    int n = [0x1013ebc] + 1;  // BUG: should be digit count of exponent, not precision
    for (int i = 0; i < n; i++) {
        int mask = 0x40000000;
        while (mask) {
            result = result * result;  // square
            if (exponent_digit[i] & mask)
                result |= sign_bit;
            mask >>= 1;
        }
    }
}
```

## Address-to-Function Map
```
0x010119E0  WinMain
0x01008180  InitPrecision (sets [0x1013ebc]=42, [0x1013eb8]=0, [0x1013eb0])
0x01007465  BigNum_Power (outer=43 iterations, inner=30 bit-scan)
0x01007AF5  ConvertToBase (value → base-N digit array)
0x01011506  BigNum_Multiply (O(n×m) schoolbook)
0x01011564  BigNum_Multiply_Inner (shrd+mul+adc loop)
0x01010B08  BigNum_Create
0x01007349  LocalFree wrapper
0x0100592A  SciCalc WndProc
```
