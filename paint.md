# MSPaint Debugging Notes

## Current Status (2026-04-01)

### Working

- msvcrt.dll DllMain returns cleanly (EAX=1) ← **fixed** by SAHF/LAHF + GetSystemTimeAsFileTime + DLL_TABLE relocation
- mfc42.dll (ANSI) DllMain crashes on `_EH_prolog` (trapped and recovered)
- MFC42 IAT patching works — EXE's MFC42.DLL imports patched to loaded mfc42.dll
- MSVCRT IAT patching works (EXE's CRT calls go to real msvcrt.dll code)
- Real msvcrt _initterm iterates init function table and calls entries
- API_HASH_COUNT now auto-generated — can't go stale
- Fallback handler crashes with full diagnostics instead of silent stack corruption

### Current Blocker: `_EH_prolog` not implemented

`_EH_prolog` is an MSVCRT export used by MFC42's structured exception handling
setup. It's called during both MFC42 DllMain and the main EXE's CRT startup
(via MFC42 code). Without it, MFC42 DllMain crashes (trapped/recovered), and
then the EXE itself crashes at batch 0 when it enters MFC42 code.

The crash happens at EIP=0x0105607d (inside mfc42.dll), which is a `jmp` thunk
for `_EH_prolog`. The call chain: entry 0x0102f350 → CRT init → MFC42 ordinals
→ `_EH_prolog`.

`_EH_prolog` is a special function — it's not a normal stdcall API. It sets up
an SEH frame using a custom calling convention:
- On entry: EAX = exception handler address, return addr on stack
- It pushes EBP, sets up the SEH chain via FS:[0], and adjusts EBP/ESP

**Next:** Implement `_EH_prolog` as a special handler (not a regular Win32 API
dispatch). It manipulates the stack and FS segment directly. See Wine source or
MSVC CRT source for the exact register/stack protocol.

**Note:** GetClassInfoA (previously listed as blocker) is now in api_table and
dispatch. The regression to `_EH_prolog` is because the loaded mfc42.dll binary
changed — the current ANSI mfc42.dll exercises this codepath during DllMain.

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

### Uncommitted Fixes (2026-04-01)

7. **SAHF/LAHF instructions** — Decoder opcodes 0x9E/0x9F, handlers 212/213.
   SAHF loads SF/ZF/CF from AH into lazy flag system; LAHF stores flags to AH.
   Required by msvcrt DllMain (FPU control word checks use SAHF).

8. **GetSystemTimeAsFileTime** — Was a crash stub, now writes a fixed FILETIME
   (~2000-01-01) to the output pointer. 1 arg stdcall. Required by msvcrt init.

9. **DLL_TABLE relocated** — Moved from 0x1363000 to 0x1366000 to avoid overlap
   with expanded 16KB API hash table (up to 2048 entries).

10. **FillRect uses gdi_fill_rect** — New host import `gdi_fill_rect` takes hBrush
    parameter separately (previously reused gdi_rectangle which used DC brush).

11. **Handler table expanded** — 212→214 entries for SAHF/LAHF.

### Previous Fixes (from earlier sessions)

- __p__wcmdln NULL fix
- GetVersionExA NT detection with --winver=nt4
- jmp reg thunk dispatch for MFC patterns
- Dynamic thunk bounds ($update_thunk_end)
- GetProcAddress api_id thunks
- HeapSize, IsProcessorFeaturePresent, CoRegisterMessageFilter stubs

### Run Command

```bash
node test/run.js --exe=test/binaries/mspaint.exe --max-batches=2000 --batch-size=1000 \
  --trace-api --dlls=test/binaries/dlls/msvcrt.dll,test/binaries/dlls/mfc42.dll --winver=nt4
```

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
