# Bug Fixes — Flag System, Shift CF, and IDIV Overflow

## 1. Overflow Flag (OF) and Sign Flag (SF) incorrect for 8-bit and 16-bit operations

**Problem:** `$get_of` and `$get_sf` hardcoded bit 31 as the sign bit position. For 8-bit ALU ops (where results are masked to 0xFF) and 16-bit ALU ops (masked to 0xFFFF), the sign bit is at bit 7 or bit 15 respectively. This meant OF and SF were always 0 for sub-32-bit operations.

**Example:** `ADD AL, 127 + ADD AL, 1` should set OF (signed 8-bit overflow), but the old code checked bit 31 of 128 (0x00000080) which is 0.

**Fix:** Added a `$flag_sign_shift` global (default 31) that tracks the operand size. `$get_sf` and `$get_of` now shift by this global instead of hardcoded 31. All flag-setting functions (`$set_flags_add`, `$set_flags_sub`, `$set_flags_inc`, `$set_flags_dec`) reset it to 31. All 8-bit ALU handlers set it to 7 after flag computation, and all 16-bit ALU handlers set it to 15.

**Affected handlers (8-bit, set to 7):**
- `$th_alu_m8_r`, `$th_alu_r_m8`, `$th_alu_m8_i8`
- `$th_alu_r8_r8`, `$th_alu_r8_i8`
- `$th_alu_m8_r_ro`, `$th_alu_r_m8_ro`, `$th_alu_m8_i_ro`

**Affected handlers (16-bit, set to 15):**
- `$th_alu_r16_m16`, `$th_alu_m16_r16`
- `$th_alu_r16_m16_ro`, `$th_alu_m16_r16_ro`
- `$th_alu_m16_i16`

## 2. Shift/Rotate Carry Flag (CF) stored in wrong variable

**Problem:** `$set_flags_shift` stored the carry-out bit in `$saved_cf`, but `$get_cf` for shift operations (flag_op == 7) reads from `$flag_b`.

**Fix:** Changed `$set_flags_shift` to store the CF value in `$flag_b` instead of `$saved_cf`.

## 3. Signed division overflow not detected (IDIV)

**Problem:** `IDIV` with dividend `0xFFFFFFFF80000000` (i.e. EDX:EAX = -2147483648) and divisor `-1` should raise a #DE exception (the result 2147483648 doesn't fit in a signed 32-bit register). The old code attempted the division, which would produce an incorrect result or trap in WebAssembly.

**Fix:** Added an explicit check in both `$th_idiv32` and `$th_idiv_m32` that raises exception #DE when `divisor == -1 && dividend == 0xFFFFFFFF80000000`.

## 4. RCL/RCR (Rotate through Carry) were no-ops

**Problem:** `$do_shift32` had no implementation for shift types 2 (RCL) and 3 (RCR). They fell through to the fallback which returned the value unchanged. These are needed for multi-precision arithmetic and compiler-generated bit manipulation.

**Fix:** Implemented both as loop-based 33-bit rotations (32 data bits + carry flag). Each iteration shifts one bit through the carry, correctly maintaining the CF. The result and final CF are stored via `$set_flags_shift`.

## 5. ROL/ROR did not set Carry Flag

**Problem:** `ROL` and `ROR` in `$do_shift32` returned the rotated value without calling `$set_flags_shift`, so CF was not updated. On real x86, ROL sets CF to bit 0 of the result (the bit that rotated around), and ROR sets CF to bit 31.

**Fix:** Both now call `$set_flags_shift` with the appropriate CF value after rotation.

## 6. 8-bit ADC/SBB Carry Flag incorrect when b+cf overflows 8 bits

**Problem:** In `$th_alu_r8_r8` and `$th_alu_r8_i8`, the ADC case passed `b+cf` (which can be 0x100 when b=0xFF and cf=1) to `$set_flags_add`. The CF check (`flag_res < flag_a`) would give wrong results because `b_eff` exceeds the 8-bit range. Similarly for SBB.

**Example:** `ADC 0xFF, 0xFF` with CF=1: full sum = 0x1FF, should carry. But `flag_res=0xFF, flag_a=0xFF`, so CF = `0xFF < 0xFF` = false (wrong).

**Fix:** Compute the full unmasked sum/difference, then after `$set_flags_add`/`$set_flags_sub`, override the CF globals if the full result overflows 8 bits (>= 0x100 for ADC, or has bits above 0xFF set for SBB). Also save `$cf_in` once to avoid calling `$get_cf` after flag state changes.
