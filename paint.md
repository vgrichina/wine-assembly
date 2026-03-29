# MSPaint.exe Debug Analysis

## Current Status (2026-03-29)

### CRT init completes — crashes entering WinMain

DLL loader working. msvcrt.dll and MFC42u.DLL execute as real x86 code.
All 45 CRT `_initterm` callbacks complete successfully (300 API calls).
Crashes after CRT startup epilog — RET pops 0, EIP=0.

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
    __wgetmainargs --------> OK (API #257, wide argv)
    _initterm(1000,10b4) --> OK (real msvcrt x86, 45 callbacks)
      Each callback:
        EnterCriticalSection -> HeapSize -> HeapReAlloc -> LeaveCriticalSection
      All 45 complete successfully
       |
       v
  *** CRASH ***  EIP=0, ESP=0x01900004 (stack top)

  Likely cause: CRT calls WinMain but stack frame is wrong,
  or __wgetmainargs returned bad data causing CRT epilog to fail.
```

### What's working

```
Component              Status
---------              ------
DLL loader             WORKING — sections mapped, relocations applied
Export table parsing    WORKING — ordinal + name resolution
Import patching        WORKING — EXE IAT points to DLL x86 code
msvcrt.dll x86 exec    WORKING — _controlfp, _initterm, malloc, free
MFC42u.DLL x86 exec    WORKING — static constructors run via _initterm
TLS                    WORKING — TlsAlloc/Get/Set with 64 slots
Critical sections      WORKING — no-op stubs (single-threaded)
Interlocked ops        WORKING — Increment/Decrement/Exchange
FWAIT opcode           WORKING — treated as NOP
FPU block continuation WORKING — FPU ops no longer terminate blocks
Wide-char APIs         WORKING — 20+ W-suffix stubs
```

### Next steps

1. Debug WinMain entry crash — check stack at _initterm return
2. May need `_initterm` to properly return to CRT code (stack alignment)
3. May need `__wgetmainargs` to set up wider startup state
4. Once WinMain enters: MFC42u `AfxWinMain` will need many USER32/GDI32 W-stubs

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
       +--system DLLs via thunks--> WASM dispatch (347 APIs)
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

## API Trace (300 calls, CRT init)

```
#1   GetModuleFileNameW(0, buf, 260)
#2   HeapAlloc(0, 0, 16)
#3   TlsAlloc() -> 0
#4   InitializeCriticalSection(0x01182024)
#5   EnterCriticalSection(0x01182024)
#6   GlobalAlloc(0x2002, 256)
#7   GlobalLock(...)
#8   LeaveCriticalSection(0x01182024)
#9   TlsGetValue(0)
#10  LocalAlloc(0x40, 0x178)        <- MFC thread state
#11  TlsGetValue(0)
#12  LocalAlloc(0x40, 16)
#13-14 Enter/LeaveCriticalSection
#15  LocalAlloc(0, 8)
#16  TlsSetValue(0, ptr)
#17+ EnterCriticalSection -> HeapSize -> HeapReAlloc -> LeaveCriticalSection
     (repeated for each _initterm callback at 0x01001008..0x010010b0)
...
#300 LeaveCriticalSection           <- last _initterm callback done
     -> RET -> EIP=0 CRASH
```

## Files Modified

```
src/parts/01-header.wat      — DLL globals, TLS globals, initterm state
src/parts/01b-api-hashes.wat — 347 API hashes (regenerated)
src/parts/07-decoder.wat     — FWAIT NOP, FPU block continuation fix
src/parts/08-pe-loader.wat   — Store SizeOfImage for DLL loader
src/parts/08b-dll-loader.wat — NEW: DLL loader, relocations, exports, imports
src/parts/09-dispatch.wat    — 90+ new API stubs
src/parts/10-helpers.wat     — Wide string helpers, dll_name_match
src/api_table.json           — 347 APIs
tools/gen_api_table.js       — New API entries
lib/dll-loader.js            — NEW: Shared JS DLL loading module
host/host.js                 — loadDlls() for browser
host/index.html              — DLL config for mspaint
test/run.js                  — --dlls flag, uses shared module
test/binaries/dlls/          — msvcrt.dll, mfc42u.dll from VC6 redist
```
