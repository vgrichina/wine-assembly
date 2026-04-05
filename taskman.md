# Task Manager (Win98) — FAIL

**Binary:** `test/binaries/win98-apps/taskman.exe`  
**imageBase:** 0x400000, **sizeOfImage:** 0xc000  
**DLLs:** comctl32.dll (loaded at 0x40c000)

## Crash

"memory access out of bounds" after `SetWindowLongA(0x10003, GWL_WNDPROC, 0x40150c)` returns. The next call would be `LoadAcceleratorsA` at IAT `[0x4094fc]`.

WASM stack: function 1377 (`$run_block`) → function 1411 (`$win32_dispatch`). The OOB happens in the dispatch function, not in user code.

## API Trace (last 5 before crash)

```
#252 GetDlgItem(0x10001, 0xc8)
#253 GetWindowLongA(0x200c8, GWL_STYLE)
#254 CreateWindowExA(0x200, "listbox", NULL, 0x54100b51, 0, 0, 376, 237)  → hwnd=0x10003
#255 GetWindowLongA(0x10003, GWL_WNDPROC)
#256 SetWindowLongA(0x10003, GWL_WNDPROC, 0x40150c)
*** CRASH: memory access out of bounds
```

## Analysis

The crash is systemic — same WASM function/offset as Telnet. Both apps load DLLs. The crash occurs when the x86 runner dispatches the next API call after returning from SetWindowLongA. Likely cause: the thunk or IAT entry resolves to an address that produces an out-of-range WASM offset during `g2w` or stack arg reads.

## Related

Same class of bug as Telnet (see `telnet.md`). Fixing one likely fixes both.

**Key files:** `src/03-registers.wat` (g2w), `src/09b-dispatch.wat`, `src/07-decoder.wat`
