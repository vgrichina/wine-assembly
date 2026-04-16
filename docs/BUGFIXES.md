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

## 7. 8-bit and 16-bit shifts executed as 32-bit

**Problem:** Opcodes 0xC0, 0xD0, 0xD2 (8-bit shifts) and 0xC1/0xD1/0xD3 with 0x66 prefix (16-bit shifts) were decoded identically to their 32-bit counterparts, using `$do_shift32`. This meant SHR on an 8-bit register would shift out bits 0-7 as if they were 32-bit, giving wrong results for SHR, SAR, ROL, ROR, RCL, RCR.

**Fix:** Added `$do_shift8` (8-bit) and `$do_shift16` (16-bit) shift functions with correct bit widths for all shift/rotate types. Added thread handlers `$th_shift_r8` (191), `$th_shift_m8` (192), `$th_shift_r16` (193), `$th_shift_m16` (194). Updated the decoder to emit the correct handler based on opcode parity (even=8-bit, odd=32/16-bit) and 0x66 prefix.

## 8. CMPXCHG8B not implemented

**Problem:** The 0x0F 0xC7 opcode (CMPXCHG8B) was not decoded, causing unrecognized opcode errors. This instruction is used for 64-bit compare-and-swap operations, common in CRT initialization and lock-free data structures.

**Fix:** Added `$th_cmpxchg8b` (handler 195) which compares EDX:EAX with the 8-byte value at [addr]. If equal, sets ZF=1 and stores ECX:EBX; if not equal, sets ZF=0 and loads the memory value into EDX:EAX. Added decoder support for 0x0F 0xC7 with ModRM reg=1.

## 9. POPFD only restored ZF, not CF/SF/OF

**Problem:** `$load_eflags` (used by POPFD and IRET) only set up `flag_res` to encode ZF. CF, SF, and OF were not restored. Any code that pushed flags, modified them, and popped them back would lose carry, sign, and overflow state. This broke SEH dispatch and flag-dependent control flow.

**Fix:** Added a new `flag_op=8` (raw mode) where CF is stored directly in `$flag_a`, OF in `$flag_b`, and ZF/SF encoded in `$flag_res` (bit 31 = SF, zero iff ZF). Updated `$get_cf` and `$get_of` to check for flag_op=8 and return the stored values directly. The existing `$get_zf` and `$get_sf` work automatically via `$flag_res` and `$flag_sign_shift`.

## 10. Dialog proc not stored in window table (NSIS installer)

**Problem:** `CreateDialogParamA` dispatched `WM_INITDIALOG` to the dialog proc but never stored the proc in the window table. Subsequent `SendMessageA` calls to the dialog window couldn't find the dialog proc and fell through to `DefWindowProcA`. This prevented NSIS installer pages from receiving custom messages (e.g., the "start extraction" notification on the InstFiles page).

**Fix:** Added `wnd_table_set(0x10002, dlgProc)` in `$handle_CreateDialogParamA` before dispatching WM_INITDIALOG.

## 11. Thread VFS isolation (NSIS file extraction)

**Problem:** Each thread created by `ThreadManager` got a fresh `VirtualFS` instance via `createHostImports`. The extraction thread couldn't read the installer EXE because it only existed in the main thread's VFS. File creation succeeded but decompression read garbage.

**Fix:** Pass `ctx.vfs` from the main context to the worker context so threads share the same virtual filesystem. Also pass `ctx.exports` so the thread's `g2w()` correctly converts guest addresses (was using raw guest addresses as WASM offsets, causing decompressed data to be written to wrong memory locations).

## 12. FreeLibrary infinite loop (NSIS UnRegDLL)

**Problem:** NSIS calls `while(FreeLibrary(h)) {}` to fully unload a DLL before re-registering. Our `FreeLibrary` always returned TRUE (success), causing an infinite loop (28,847 calls before batch exhaustion).

**Fix:** Track the last freed handle in `$freelib_last_handle`. First call returns TRUE; repeated calls to the same handle return FALSE (already freed), breaking the loop.
