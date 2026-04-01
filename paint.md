# MSPaint Debugging Notes

## Current Status (2026-04-01)

### Working

- msvcrt.dll DllMain returns cleanly (EAX=1)
- `_EH_prolog` implemented — SEH frame setup via thunk dispatch
- MFC42 IAT patching works — EXE's MFC42.DLL imports patched to loaded mfc42.dll
- MSVCRT IAT patching works (EXE's CRT calls go to real msvcrt.dll code)
- Real msvcrt _initterm iterates init function table and calls entries
- SEH chain (fs:[0]) saved/restored on DllMain trap recovery
- CRT functions fixed to cdecl (free, calloc, srand, wcsncpy, memset, memcpy)
- memset/memcpy use wasm memory.fill/memory.copy intrinsics
- 15 new CRT functions: malloc, _strdup, _stricmp, strlen, strrchr, strcmp,
  strcpy, strncpy, strcat, atoi, _ftol, realloc, _strlwr, _mbsrchr, _mbsinc
- EXE reaches batch 3 (was batch 0 at start of session)

### Current Blocker: `GetClassInfoA` (batch 9)

MSPaint now reaches batch 9 (was batch 3). OleInitialize, RegCreateKeyExA,
_mbschr all resolved. Crash on `GetClassInfoA` — needs implementation.

### OleInitialize Root Cause (RESOLVED)

**Problem:** API hash table at WASM 0x01362000 was corrupted by mfc42's DllMain.
During DllMain init, `rep stosd` (x86 instruction) with a wild EDI pointer wrote
zeros through `$gs32` → `g2w(0x02350000)` = WASM 0x01362000 (hash table).
`$lookup_api_id` found zero hashes everywhere → returned 0xFFFF for all runtime
GetProcAddress lookups.

**Fix:** Moved API hash table from WASM 0x01362000 to 0x00004000 (below GUEST_BASE).
No valid guest address maps to this range via `g2w`, so it's safe from guest writes.
Updated `$API_HASH_TABLE` global, `gen_api_table.js`, and CLAUDE.md memory map.

### New APIs added this session

- RegCreateKeyExA — 9 args stdcall, delegates to host_reg_create_key
- _mbschr — find first byte occurrence in multibyte string (cdecl)

### Fixes Made This Session

1. **API_HASH_COUNT fix + automation** — Was hardcoded to 702 while hash table had
   705+ entries. Moved `API_HASH_COUNT` global into `01b-api-hashes.generated.wat`
   so `gen_api_table.js` emits it automatically — can never go stale.

2. **Crash-on-unimplemented** — `$handle_fallback` now calls `$host_crash_unimplemented`
   (prints name, registers, 16 stack dwords) then `unreachable`. `$host_crash_unimplemented`
   in host-imports.js uses `ctx.exports` for full register dump.

3. **disasm.js --base flag** — `node tools/disasm.js <dll> --base=0xLOADADDR <runtimeVA>`
   auto-computes file offset from runtime address, no manual pointer math needed.

4. **New API implementations:**
   - GetModuleHandleA — NULL→image_base, non-NULL searches DLL table via `$find_dll_by_name`
   - GetModuleHandleW — NULL→image_base (W DLL lookup TODO)
   - GetEnvironmentVariableA — return 0 (not found), 3 args stdcall
   - GetVersion — return `$winver` global, 0 args
   - GetCurrentThreadId — return 1, 0 args
   - GetProcessVersion — return `$winver`, 1 arg stdcall
   - SetErrorMode — return 0, 1 arg stdcall
   - HeapCreate — return fake handle 0x140000, 3 args stdcall
   - GetOEMCP — return 437, 0 args
   - GetACP — return 1252, 0 args
   - GetStringTypeW — ASCII character classification (CT_CTYPE1)
   - RegisterWindowMessageA — return unique ID from shared 0xC000+ counter
   - SetWindowsHookExA/W — return fake handle 0xBEEF, 4 args stdcall
   - InitializeCriticalSection, EnterCriticalSection, LeaveCriticalSection,
     DeleteCriticalSection — all no-op (single-threaded), 1 arg stdcall
   - LCMapStringA/W — identity copy with ASCII upper/lower case mapping, 6 args
   - GetSysColorBrush — create solid brush from sys color index
   - GetCurrentThread — return pseudo-handle 0xFFFFFFFE
   - GetSystemDirectoryA — return "C:\WINDOWS\SYSTEM"
   - SystemParametersInfoA/W — return TRUE (no-op)
   - OleInitialize — return S_OK
   - CoRegisterMessageFilter — return S_OK, write NULL to out param
   - CoTaskMemFree — call heap_free
   - RegOpenKeyExA — return ERROR_FILE_NOT_FOUND (2)
   - RegSetValueA/W — return ERROR_SUCCESS (0)
   - RegQueryValueA — return ERROR_FILE_NOT_FOUND (2)
   - CreatePatternBrush — fallback to solid gray brush
   - LoadMenuA — return handle encoded with resource ID
   - GetShortPathNameA — copy long path as-is
   - StringFromCLSID — full GUID→wide string formatting with heap alloc
   - ExtractIconA/W — return fake icon handle
   - DestroyIcon — return TRUE
   - SetCursor — return 0 (no previous cursor)

5. **Added to api_table.json** (only W versions existed):
   SetWindowsHookExA, SystemParametersInfoA, RegSetValueA, ExtractIconA, RegQueryValueA

6. **Helper: $find_dll_by_name** — searches DLL_TABLE by export directory name,
   returns guest load_addr or 0. Used by GetModuleHandleA.

### Recent Commits (2026-04-01)

7. **`_EH_prolog` implemented** (api_id 716) — SEH frame setup with custom
   calling convention. Pushes trylevel(-1), handler(EAX), old fs:[0]; sets
   fs:[0]=ESP, saves EBP, sets EBP to frame, returns to caller.

8. **SEH chain restoration** — callDllMain saves/restores fs:[0] on trap,
   preventing stale SEH pointers from corrupting later execution.

9. **SAHF/LAHF, GetSystemTimeAsFileTime, DLL_TABLE relocation, FillRect,
   auto-detect DLLs** — committed in f94d8ba and a5b9efb.

10. **cdecl fix + CRT batch** (4b9d546) — Fixed 6 handlers stdcall→cdecl.
    memset/memcpy now use memory.fill/memory.copy. Added 15 CRT functions.
    MSPaint batch 0 → batch 3.

### Previous Fixes (from earlier sessions)

- __p__wcmdln NULL fix
- GetVersionExA NT detection with --winver=nt4
- jmp reg thunk dispatch for MFC patterns
- Dynamic thunk bounds ($update_thunk_end)
- GetProcAddress api_id thunks
- HeapSize, IsProcessorFeaturePresent, CoRegisterMessageFilter stubs

### Run Command

```bash
node test/run.js --exe=test/binaries/mspaint.exe --max-batches=50 --trace-api
```
DLLs auto-detected from EXE imports (mfc42.dll, msvcrt.dll from test/binaries/dlls/).

### EXE Import Dependencies

```
MFC42.DLL    — 618 ordinal imports (ANSI mfc42.dll now in place)
MSVCRT.dll   — CRT functions
ADVAPI32.dll — registry APIs (thunked)
KERNEL32.dll — core Win32 (thunked)
GDI32.dll    — graphics (thunked)
USER32.dll   — windowing (thunked)
comdlg32.dll — common dialogs (thunked)
ole32.dll    — COM (thunked)
SHELL32.dll  — shell APIs (thunked)
IMM32.dll    — input method (thunked)
```

### DLLs in test/binaries/dlls/

- msvcrt.dll (required, working)
- mfc42.dll (ANSI version, correct for MSPaint)
- msvcp60.dll (not needed by MSPaint)
- oleaut32.dll (not needed by MSPaint)

### CRT Startup Flow (with real msvcrt.dll + mfc42.dll)

1. Entry 0x0102f350 — sets up SEH frame
2. `__set_app_type(2)` via IAT → real msvcrt code
3. `__p__fmode` → returns fmode pointer
4. `__p__commode` → returns commode pointer
5. `_controlfp(0x10000, 0x30000)` via msvcrt
6. `call 0x102f7d0` — internal init
7. `_initterm(0x0103b0b8, 0x0103b0bc)` — C++ init (empty table)
8. `__getmainargs` — sets up argc/argv
9. `_initterm(0x0103b000, 0x0103b0b4)` — C init (45 functions)
   ← previously crashed on LCMapStringW (now implemented)
10. GetStartupInfoA
11. GetModuleHandleA(NULL)
12. Parse command line
13. Call AfxWinMain (MFC42 ordinal 1576) via 0x1032b91

### Memory Layout

- MSPaint image_base: 0x01000000
- mfc42.dll loaded at: 0x01055000
- msvcrt.dll loaded at: 0x01142000
- Thunk zone: 0x02000000+ (900 thunks at start, 1554 after DLL loading)
