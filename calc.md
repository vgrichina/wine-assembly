# Calc.exe Execution Analysis

## Current Status (2026-03-27)

### Fixed
- **imul r,[mem] clobbered dst** — 0F AF decoded as load+square instead of multiply. Calc bignum init now completes in ~1M blocks (was stuck at 100M+).
- **INC/DEC cleared CF** — added saved_cf; bignum adc chains now preserve carry across inc counters.
- **ADC/SBB carry overflow** — b+cf_in wrap (0xFFFFFFFF+1) now forces CF=1.
- **MUL/IMUL missing flags** — CF=OF set when upper half non-zero (flag_op=6).
- **Heap OOM** — LocalFree was a no-op (bump allocator). Added free-list allocator, then reverted to bump since imul fix eliminated the 100M-block alloc storm. Re-add free-list when needed.

### Fixed (cont.)
- **Button clicks not working** — Three issues:
  1. Resource parser `readOrdOrSz` lost string values (`.str` vs `.val` key mismatch) → dialog className "SciCalc" was `undefined`
  2. `GetMessageA` always set msg.hwnd to `$main_hwnd` (0x10001, hidden helper window) instead of the actual target hwnd from the input event → message loop couldn't route to dialog
  3. `IsChild` always returned 0; `SendMessageA` only dispatched to main window
  - Added `host_check_input_hwnd` import to pass hwnd from renderer through input pipeline
  - Added `$dlg_hwnd` global (saved from CreateDialogParamA) for IsChild and SendMessageA routing
  - Confirmed: calc's dialog template specifies `className="SciCalc"` (same class as main window), dlgProc is NULL → all messages dispatched to SciCalc WndProc at 0x100592A via `$wndproc_addr`
  - Test confirms: injecting WM_COMMAND(id=125="1") triggers SetDlgItemTextA to update display

### Fixed: Arithmetic operations now work
- **`_strrev` was stubbed as no-op** — BigNum_ToString builds digits in reverse, relies on `_strrev` to flip. Without it, the reversed string was misinterpreted as "0.". Implemented `_strrev` in WASM.
- **`strchr` was stubbed as "not found"** — needed for decimal point formatting. Implemented properly.
- **ADC/SBB carry flag in threaded handlers** — `th_adc_r_i32`, `th_adc_r_r`, `th_sbb_r_i32`, `th_sbb_r_r` passed `b` instead of `b_eff=b+cf` to `set_flags_add/sub`. Fixed to match `$do_alu32` pattern with wrap detection. Also fixed 8-bit ADC/SBB in `th_alu_r8_r8` and `th_alu_r8_i8`.
- **Verified**: 5+9=14, 500/9=55.555...556 (32-digit precision), 123×456=56088. All correct.

### Open Tasks
1. **Re-add heap free-list** — reverted to bump allocator; will OOM on long runs
3. **FPU stubs** — no x87 support; may be needed for CRT or standard-mode calc
4. **RCL/RCR** — rotation-through-carry currently stubbed approximate

## Overview
Win98 calc.exe (image_base=0x01000000, entry=0x010119e0). Gets stuck in bignum math
library initialization — never reaches the message loop or creates the main UI window.

## Execution Phases

### Phase 1: CRT Init (blocks 0–100, EIP ~0x010119e0–0x01001650)
```
__set_app_type → __p__fmode → __p__commode → _controlfp → _initterm
→ __getmainargs → _initterm → GetStartupInfoA → GetModuleHandleA
→ _EH_prolog → GetCommandLineA → CharNextA x7
```
Standard MSVC runtime startup. Parses command line, sets up CRT globals.

### Phase 2: Window Class Registration (blocks ~100, EIP ~0x01001650)
```
LoadIconA → LoadCursorA → GetSysColorBrush → RegisterClassExA
```
Registers the "CalcMsgPumpWnd" window class. Only one class registered.

### Phase 3: String Table Load (blocks 100–400, EIP ~0x01001620–0x01001650)
```
LoadStringA x80 (IDs 0–79)
```
Loads calculator button labels, operator names, etc. from string resources.
Currently LoadString returns 0 (no strings loaded) — may need real data.

### Phase 4: Hidden Helper Window (block ~400, EIP ~0x01008257)
```
LocalReAlloc → CreateWindowExA("CalcMsgPumpWnd", CW_USEDEFAULT)
```
Creates the message pump helper window (hwnd=0x10001, size=-2147483648x0).
This is NOT the main calculator window — it's a hidden IPC/pump window.

### Phase 5: Profile Parsing (blocks 400–500, EIP ~0x01007xxx)
```
lstrcpyA → lstrlenA → lstrcpyA → lstrlenA → LocalAlloc x4
```
Brief ini/profile parsing section — reads calc settings.

### Phase 6: Bignum Library Init — STUCK HERE (blocks 500+)
**Address range: 0x01010B00–0x01011700 (bignum math library)**
**Address range: 0x01007349–0x010073CD (LocalAlloc/Free wrappers)**

#### Key functions identified by disassembly:

| Address | Function | Notes |
|---------|----------|-------|
| 0x01011506 | BigNum_Multiply | Nested loop, `mul dword` inner product, O(n*m) |
| 0x0101147E | BigNum_Power / Karatsuba split | Calls multiply recursively |
| 0x01010B08 | BigNum_Alloc wrapper | Allocates and initializes bignum structs |
| 0x01010C00–0x01010CFF | BigNum_Add/Sub/Shift | Various bignum arithmetic ops |
| 0x01007349 | LocalAlloc thunk | `heap_alloc` wrapper called from bignum |
| 0x01007387 | LocalAlloc thunk (alt entry) | Same |
| 0x010073AC | LocalFree thunk | Frees temp bignums |
| 0x010074C4–0x010074EA | Power-of-10 loop | Iterates computing 10^N for precision table |
| 0x01007AF5 | BigNum init entry | Sets up precision table |
| 0x01007B20–0x01007CF3 | Precision table builder | Computes large powers |

#### What it's computing:
Calc.exe uses an arbitrary-precision integer library for its scientific mode.
During init, it precomputes a **table of powers of 10** (10^1, 10^2, 10^4, 10^8,
... up to 10^(2^N)) for its 32-digit precision. Each successive power requires
multiplying the previous one by itself — the numbers grow exponentially, and the
bignum multiply is O(n^2) in the number of "digits" (32-bit words).

#### Allocation pattern:
- Total allocs observed: 157K+ in 20M blocks, still growing
- Sizes: 8–1712 bytes (max reached early, then stabilizes at 44–68 byte allocs)
- The library allocs temp buffers for intermediate multiply results, then frees them
- **Fixed**: LocalFree now actually frees (was no-op before, caused OOM at ~10M blocks)

### Phase 7: NEVER REACHED — Main Window Creation
After bignum init, calc would:
```
CreateWindowExA("SciCalc", "Calculator", ...) → CreateDialog → ShowWindow
→ LoadMenuA → SetMenu → GetMessageA → DispatchMessageA (message loop)
```

## Root Cause: Why Calc is Stuck

The bignum power-of-10 precomputation is an O(n^2 * log(P)) algorithm where P is
the target precision and n grows with each power level. On real x86, this takes
milliseconds. In our interpreted WASM emulator, each x86 instruction goes through
decode→dispatch→execute, making it ~1000x slower.

**Estimated blocks needed**: Based on growth rate (~20K allocs per 5M blocks, with
allocs getting slower as numbers grow), the full computation likely needs
**500M–1B+ blocks**, taking minutes even with the free-list fix.

## Options to Proceed

1. **Patience**: Run ~1B blocks (~5 min) and see if it finishes
2. **Skip bignum init**: Detect the init function and return early with empty table
   (calc will show "0" but the UI will work)
3. **Native bignum**: Replace the hot multiply loop with a WASM intrinsic
4. **Patch calc.exe**: NOP out the precompute loop in the binary
5. **Block caching**: The JIT cache should help since the same basic blocks repeat

## Address-to-Function Map

```
0x010119E0  WinMain (entry point)
0x01001620  LoadStringTable (loads 80 strings)
0x01008200  InitCalcApp (creates helper window, starts bignum init)
0x01007AF5  InitPrecisionTable (bignum library setup)
0x01007B20  ComputePowerTable (iterative squaring loop)
0x0101147E  BigNum_Power (recursive power computation)
0x01011506  BigNum_Multiply (core multiply, O(n*m))
0x01010B08  BigNum_Create (alloc + init struct)
0x01010C00  BigNum_Add
0x01010C40  BigNum_Sub
0x01010C70  BigNum_ShiftRight
0x0100EEE5  BigNum_Divide (uses _CxxThrowException on div-by-zero)
0x010078E2  BigNum_ToString (_strrev + formatting)
0x01007F42  BigNum_Cleanup
0x01009549  BigNum_Compare
```
