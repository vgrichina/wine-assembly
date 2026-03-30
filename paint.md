# MSPaint.exe Debug Analysis

## Binary Sources

| Version | Source | File |
|---------|--------|------|
| Win95 OSR2 (MFC30) | [archive.org/details/MSPaintWin95](https://archive.org/details/MSPaintWin95) | 312KB, base 0x400000, imports MFC30.DLL + msvcrt20.dll |
| Win98/2000 (MFC42 ANSI) | [archive.org/details/mspaint_202309](https://archive.org/details/mspaint_202309) | 344KB, base 0x1000000, imports MFC42.DLL + msvcrt.dll |
| WinXP (MFC42u Unicode) | original `test/binaries/entertainment-pack/mspaint.exe` (moved to `nt/`) | 447KB, base 0x1000000, imports MFC42u.DLL + msvcrt.dll |

## Current Status (2026-03-29)

### Past lstrcpynW — MFC accelerator table loading

CRT init completes, WinMain is called. MFC42u AfxWinMain begins executing.
lstrcpynW off-by-one fixed (API_HASH_COUNT was 347, should be 348).
Now ~500+ API calls. Stuck in MFC accelerator table loading — FindResourceW
loops and unhandled API calls cause stack corruption via fallback handler
(fallback only does ESP+=4 regardless of actual arg count).

```
MSPaint Execution Progress
===========================

  Entry (0x0104e860)
       |
       v
  msvcrt CRT startup (real x86 in msvcrt.dll)
    __set_app_type --------> OK (API #260)
    __p__fmode ------------> OK (API #208)
    __p__commode ----------> OK (API #209)
    _controlfp ------------> OK (real msvcrt x86, FWAIT+FSTCW handled)
    _initterm(b8,bc) ------> OK (real msvcrt x86, small table)
    __wgetmainargs --------> OK (real msvcrt x86, wide argv)
    _initterm(1000,10b4) --> OK (real msvcrt x86, 45 callbacks)
    __p__wcmdln check -----> OK (patched by DLL loader)
       |
       v
  *** WinMain ENTERED ***
    GetStartupInfoW -------> OK
    GetModuleHandleW ------> OK
    MFC TLS init ----------> OK
    SetErrorMode ----------> OK
    GetModuleFileNameW ----> OK (writes L"C:\PAINT.EXE")
    lstrcpynW -------------> OK (fixed: API_HASH_COUNT off-by-one)
    HeapAlloc -------------> OK
    FindResourceW ---------> OK (returns stub)
    LoadAcceleratorsW -----> UNHANDLED (fallback ESP mismatch)
       |
       v
  *** OOB crash in web ***  EIP=0x00000006 (fallback stack corruption)
  Fallback handler only does ESP+=4 for all unknown APIs,
  corrupting stack for stdcall functions with more args.
```

### Bugs fixed this session

1. **API_HASH_COUNT off-by-one**: Was 347, should be 348. The hash table
   has 348 entries (0-347), but the lookup loop used `< 347` as the bound,
   so the LAST entry (`lstrcpynW`, id=347) was never found. `lookup_api_id`
   returned 0xFFFF, causing br_table to hit fallback instead of the real
   handler. Fallback only did ESP+=4 (not 16 for stdcall 3-arg), corrupting
   the return address and causing execution to jump into zeroed stack memory.

2. **Test runner --exe= flag**: The positional arg was silently ignored;
   must use `--exe=path` to specify the binary. Without it, defaults to
   notepad.exe.

### Previous bugs fixed

1. **CRT skipping WinMain**: msvcrt's `_wcmdln` was NULL because DllMain
   never runs. DLL loader now patches `__p__wcmdln`, `__p__wenviron`, etc.

2. **16-bit TEST (66 85)**: Decoded as 32-bit TEST, causing _wsetargv's
   NUL check to fail.

3. **GetModuleFileNameW**: Was a no-op stub. Now writes L"C:\PAINT.EXE".

4. **GetEnvironmentStrings/W**: Returned empty blocks.

5. **gen_dispatch.js**: Rewritten to extract handler bodies from current file.

### What's working

```
Component              Status
---------              ------
DLL loader             WORKING — sections mapped, relocations applied
Export table parsing    WORKING — ordinal + name resolution
Import patching        WORKING — EXE IAT points to DLL x86 code
msvcrt.dll x86 exec    WORKING — _controlfp, _initterm, malloc, free
MFC42u.DLL x86 exec    WORKING — static constructors run via _initterm
CRT globals init       WORKING — _wcmdln, _wenviron, _environ patched
TLS                    WORKING — TlsAlloc/Get/Set with 64 slots
Critical sections      WORKING — no-op stubs (single-threaded)
Interlocked ops        WORKING — Increment/Decrement/Exchange
FWAIT opcode           WORKING — treated as NOP
FPU block continuation WORKING — FPU ops no longer terminate blocks
Wide-char APIs         WORKING — 20+ W-suffix stubs
16-bit TEST            WORKING — prefix_66 handled for opcode 0x85
WinMain entry          WORKING — CRT calls wWinMain, MFC starts
lstrcpynW              WORKING — API hash count fixed
MFC module filename    WORKING — path parsing proceeds correctly
```

### Next steps

1. Implement LoadAcceleratorsW (or stub it properly with correct ESP cleanup)
2. The fallback handler needs smarter ESP cleanup — currently ESP+=4 for
   ALL unknown APIs causes stack corruption for any stdcall function with
   args. Consider logging the name and returning with ESP+=4 only for
   truly 0-arg functions.
3. MFC will need many more USER32/GDI32 W-stubs for window creation

## Architecture

```
  MSPaint.exe                 msvcrt.dll              MFC42u.DLL
  (0x01000000)                (0x0106f000)            (0x010b3000)
  +----------+                +----------+            +----------+
  | x86 code |--IAT patched-->| x86 code |            | x86 code |
  |          |                |          |--thunks--->| WASM stubs|
  |          |--IAT patched-->|          |            |          |
  |          |                +----------+            +----------+
  |          |--IAT patched------------------------------>|
  +----------+                                           |
       |                                                 |
       +--system DLLs via thunks--> WASM dispatch (348 APIs)
```

## DLL Load Map

```
Guest Address   Module           Size     Relocations
-----------     ------           ----     -----------
0x01000000      mspaint.exe      0x6F000  N/A (at preferred base)
0x0106f000      msvcrt.dll       0x44000  delta=-0x76F91000, 9948 bytes
0x010b3000      MFC42u.DLL       0xF2000  delta=-0x5E74D000, 60900 bytes
0x01b00000      Thunk zone       0x40000  1433 thunks
```

## Import Resolution

```
msvcrt.dll imports:
  KERNEL32.dll: 144 functions -> our WASM thunks

MFC42u.DLL imports:
  MSVCRT.dll:   81 functions -> resolved to msvcrt.dll x86 code
  KERNEL32.dll: 124 functions -> our WASM thunks
  GDI32.dll:    113 functions -> our WASM thunks
  USER32.dll:   195 functions -> our WASM thunks

MSPaint.exe imports:
  MFC42u.DLL:   619 ordinals -> resolved to MFC42u x86 code
  msvcrt.dll:    29 functions -> resolved to msvcrt.dll x86 code
  KERNEL32.dll:  36 functions -> our WASM thunks
  USER32.dll:    84 functions -> our WASM thunks
  GDI32.dll:     72 functions -> our WASM thunks
  + ADVAPI32, SHELL32, ole32, comdlg32 -> our WASM thunks
```

## Files Modified

```
src/parts/01-header.wat      — DLL globals, TLS globals, initterm state, API_HASH_COUNT fix
src/parts/01b-api-hashes.wat — 348 API hashes (regenerated)
src/parts/07-decoder.wat     — FWAIT NOP, FPU block continuation, 16-bit TEST fix
src/parts/08-pe-loader.wat   — Store SizeOfImage for DLL loader
src/parts/08b-dll-loader.wat — NEW: DLL loader, relocations, exports, imports
src/parts/09-dispatch.wat    — 90+ new API stubs, lstrcpynW
src/parts/10-helpers.wat     — Wide string helpers, dll_name_match, wcsncpy
src/parts/13-exports.wat     — guest_alloc, guest_write16 exports
src/api_table.json           — 348 APIs
tools/gen_api_table.js       — New API entries
tools/gen_dispatch.js        — Rewritten: reads current file, regenerates br_table only
lib/dll-loader.js            — Shared JS DLL loading + msvcrt globals init
host/host.js                 — loadDlls() for browser
host/index.html              — DLL config for mspaint
test/run.js                  — --dlls flag, uses shared module
test/binaries/dlls/          — msvcrt.dll, mfc42u.dll from VC6 redist
```
