# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: FAIL (crash on IsBadWritePtr call path)

Regression from the 2026-04-09 report (was PASS 106 APIs). Current failure
mode shows `[API] IsBadWritePtr` immediately followed by
`*** CRASH: memory access out of bounds` at EIP≈0x011874fa (inside
dynamically-loaded advapi32.dll).

## Crash Context

- MSPaint calls `LoadLibraryA("advapi32.dll")` during MFC init. Our dynamic
  LoadLibrary path (commit b416e02) runs `$process_dll_imports` for the
  freshly loaded DLL.
- advapi32.dll imports from KERNEL32 include **9 ordinal-only imports**
  (ordinals 3, 9, 2, 4, 7, 5, 6, 11, 17). See
  `node tools/pe-imports.js test/binaries/dlls/advapi32.dll --all`.
- `$process_dll_imports` in src/08b-dll-loader.wat:280-285 handles these as
  "system DLL ordinal import". It creates a thunk with the marker
  `0x4F524400` ("ORD\0") but stores **0xFFFF** in the thunk's api_id slot
  instead of the real ordinal — the actual ordinal from
  `entry & 0xFFFF` is discarded.
- When dispatcher sees `name_rva=0x4F524400`, none of the CACA markers
  match, so it falls through to the "normal API dispatch" arm at
  09b-dispatch.wat:192: `name_ptr = GUEST_BASE + 0x4F524400 + 2`, then
  `$strlen(name_ptr)` + `$host_log(...)`, which read WASM memory at
  ~0x4F724xxx. Depending on WASM memory size that is either OOB (trap) or
  garbage bytes.

## Root Cause

Two bugs stack up:
1. `$process_dll_imports` stores 0xFFFF instead of the real ordinal
   (src/08b-dll-loader.wat:285). Fix: `(i32.and $entry 0xFFFF)`.
2. `$win32_dispatch` has no branch for the `0x4F524400` marker, so it
   treats it like a normal API thunk and reads name_ptr from garbage.

Even with #1 fixed, there is no name to look up, so #2 is the real gap:
we need an ordinal→name table for KERNEL32 (and any other system DLL a
dynamically-loaded DLL imports from) so ordinal imports can reuse the
existing name-based API hash table.

## Fix Sketch

Option A — cheap: add a `0x4F524400` handler in $win32_dispatch that
calls `$crash_unimplemented` with a synthetic "KERNEL32.#<ordinal>"
string. This at least turns the silent memory crash into a clear
"implement ordinal N" message.

Option B — real fix: embed a static ordinal→name map for KERNEL32
(generated from the Win98 kernel32.dll export table) in a new
`.generated.wat` file, then use it to resolve ordinal imports into
existing named thunks during `$process_dll_imports`.

Option B would also unblock WordPad (same crash signature).

## Difficulty: Medium

The two-line fix in `$process_dll_imports` + a dispatcher bail-out is
~30 minutes. The full ordinal-table approach is a day of work but
likely unblocks several MFC apps that go through advapi32.
