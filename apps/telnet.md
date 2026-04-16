# Telnet (Win98) — FAIL

**Binary:** `test/binaries/win98-apps/telnet.exe`  
**imageBase:** 0x1000000 (16MB), **sizeOfImage:** 0x30000  
**Sections:** .text (0x1001000, 0xd2e6), .data (0x100f000, 0x1cb9c BSS), .rsrc (0x102c000)

## Crash

"memory access out of bounds" after `RegCloseKey(0xbeef0001)` returns. The actual failing call is `SetLastError` at IAT `[0x100105c]`.

## API Trace (last 4 before crash)

```
#113 RegQueryValueExW(0xbeef0001, ...)
#114 RegQueryValueExW(0xbeef0001, ...)
#115 SetEnvironmentVariableW(...)
#116 RegCloseKey(0xbeef0001)
*** CRASH: memory access out of bounds
```

## Analysis

Same WASM function/offset crash as Task Manager. The distinguishing feature is the **high imageBase** (0x1000000 = 16MB). Guest stack at ESP ~0x2bff924 maps to WASM ~0x1c0b924 (~28MB). This is within the 64MB WASM memory limit, so the crash isn't a simple size overflow.

The `SetLastError` ILT entry has RVA 0xdefe, giving name_ptr = GUEST_BASE + 0xdefe + 2 = 0x1ff00. This is within the mapped .text section (WASM 0x13000–0x20400). The name "SetLastError" is present and readable.

The crash must be in `gl32` reading stack args, or in the generated dispatch table accessing handler parameters. Needs WASM-level debugging to isolate the exact `i32.load` that fails.

## Related

Same class as Task Manager (`taskman.md`).

**Key files:** `src/03-registers.wat`, `src/09b-dispatch.wat`
