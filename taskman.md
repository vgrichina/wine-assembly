# Task Manager (Win98)

**Binary:** `test/binaries/win98-apps/taskman.exe`
**imageBase:** 0x400000, **sizeOfImage:** 0xc000

## Status (2026-04-11) — FIXED

Runs to clean `ExitProcess`. Root cause was a dispatcher bug affecting
every app that imports any DLL by ordinal. Telnet had the same bug;
it also passes now.

## Root cause

taskman imports SHELL32 **by ordinal**:

```
SHELL32.dll  ILT=0x91a4  IAT=0x9408
  [0] ordinal 61
  [1] ordinal 60
  [2] ordinal 184
  [3] ordinal 181
```

The PE loader (`src/08-pe-loader.wat`) handles ordinals correctly at
load time: bit 31 set in an ILT entry triggers a call to
`$host_resolve_ordinal(dll_name, ordinal)` which returns the real api_id
stored at `thunk+4`. At `thunk+0` the loader stores the original ILT
entry unchanged — for by-name imports that's a plain RVA to an
`IMAGE_IMPORT_BY_NAME` struct; for by-ordinal imports it's
`0x80000000 | ordinal`.

`$win32_dispatch` in `src/09b-dispatch.wat` assumed `thunk+0` was
always a name RVA and unconditionally did:

```wat
(local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))
(call $host_log (local.get $name_ptr) (call $strlen (local.get $name_ptr)))
```

For a resolved-ordinal thunk, `name_rva = 0x800000B5` (or similar),
so `name_ptr = GUEST_BASE + 0x800000B5 + 2` — a wrapped garbage
pointer. `$strlen` byte-walked into unmapped WASM memory and
trapped with "memory access out of bounds" inside WAT function 1594
(`$strlen`).

The smoke runner mislabelled the failure as `SetWindowLongA` because
that was the last `[API]` line successfully logged. The actual call
that tripped the OOB was `shell32[3]` (ordinal 181), invoked
immediately after SetWindowLongA returned — it never reached the
`[API]` line because the strlen trap fired first inside the
dispatcher prologue.

## Fix

`src/09b-dispatch.wat`:

```wat
;; Resolved-ordinal import: thunk+0 holds (0x80000000 | ordinal), not an
;; IMAGE_IMPORT_BY_NAME RVA. host_resolve_ordinal found a real api_id, so
;; we have a handler to run — just substitute a placeholder name for
;; logging (and for any handler that prints name_ptr).
(if (i32.and (local.get $name_rva) (i32.const 0x80000000))
  (then
    (local.set $name_ptr (i32.const 0x2E0))
    (call $host_log (local.get $name_ptr) (i32.const 5)))
  (else
    (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))
    (call $host_log (local.get $name_ptr) (call $strlen (local.get $name_ptr)))))
```

`src/01-header.wat`:

```wat
(data (i32.const 0x2E0) "<ord>\00")
```

Unresolved ordinals still crash via the existing `"ORD\0"` marker path
earlier in the dispatcher. Per-API stubs still `$crash_unimplemented`
when hit. Fail-fast preserved — only the "resolved ordinal whose name
we can't strlen" silent-trap path was changed.

## Verification

```
$ node test/run.js --exe=test/binaries/win98-apps/taskman.exe \
    --max-batches=80 --batch-size=1000 --no-build --verbose
…
[API] RegCloseKey
[API] HeapFree
[API] DeleteObject
[API] DeleteObject
[API] ExitProcess
```

## Smoke-runner fix

Commit `6c2ee5c` improved `test/test-all-exes.js` to scrape the real
crash message and EIP from `run.js` output instead of substituting the
last `[API]` line. The last API is still shown as context. This made
diagnosing the taskman OOB possible — before, it looked like a missing
`SetWindowLongA` handler.
