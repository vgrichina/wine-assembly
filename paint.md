# MSPaint.exe Debug Analysis

## Binary Sources

| Version | Source | File |
|---------|--------|------|
| Win95 OSR2 (MFC30) | [archive.org/details/MSPaintWin95](https://archive.org/details/MSPaintWin95) | 312KB, base 0x400000, imports MFC30.DLL + msvcrt20.dll |
| Win98/2000 (MFC42 ANSI) | [archive.org/details/mspaint_202309](https://archive.org/details/mspaint_202309) | 344KB, base 0x1000000, imports MFC42.DLL + msvcrt.dll |
| WinXP (MFC42u Unicode) | original `test/binaries/entertainment-pack/mspaint.exe` (moved to `nt/`) | 447KB, base 0x1000000, imports MFC42u.DLL + msvcrt.dll |

## Current Status (2026-03-31)

### DllMain working, MFC init proceeding

Both msvcrt.dll and mfc42u.dll DllMains now complete successfully.
EXE entry runs, CRT init succeeds, WinMain entered, MFC init proceeds.
50k+ batches stable, 44+ API calls, no crashes.

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

### Bugs fixed

1. **Dispatch handler fall-through**: br_table handlers in 09-dispatch.wat
   MUST end with `(return)`. Without it, execution falls through ALL
   subsequent handlers in sequence. Root cause of ScrollWindow being
   called from msvcrt DllMain — fell through 160+ handlers from
   GetVersionExA (472) to ScrollWindow (630). Fixed by adding `(return)`
   to 351 handlers.

2. **Soft-stub stack corruption**: Old stubs returned garbage or trapped.
   Now 342 soft-stubs return 0 with proper stdcall ESP cleanup based on
   nargs from api_table.json.

3. **API_HASH_COUNT off-by-one**: Was 347, should be 348.

4. **DllMain budget**: Increased from 100k to 2M blocks.

### What's working

```
Component              Status
---------              ------
DLL loader             WORKING — sections mapped, relocations applied
Export resolution       WORKING — ordinal + name lookup
Import patching        WORKING — EXE→DLL and DLL→DLL IAT resolved
msvcrt.dll DllMain     WORKING — CRT init completes, EAX=1
MFC42u.DLL DllMain     WORKING — MFC init completes, EAX=1
CRT globals init       WORKING — _wcmdln, _wenviron, _environ patched
WinMain entry          WORKING — CRT calls wWinMain, MFC starts
MFC AfxWinMain         RUNNING — 44+ API calls, 50k batches stable
Soft-stubs             699 APIs total, ~350 soft-stubbed (return 0)
GetVersionExA          WORKING — fills OSVERSIONINFOA from $winver
LoadStringW            WORKING — calls host_load_string
```

### Next steps

1. Trace API calls to identify which soft-stubs need real implementations
2. MFC window creation flow (CreateWindowExW, RegisterClassExW)
3. Resource loading (FindResource/LoadResource)
4. GDI painting operations

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
       +--system DLLs via thunks--> WASM dispatch (699 APIs)
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
