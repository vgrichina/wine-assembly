# MSPaint.exe Debug Analysis & DLL Loading Plan

## Current Status (2026-03-29)

### DLL Loading WORKS — stuck on FPU opcode

DLL loader implemented. msvcrt.dll and MFC42u.DLL load into guest memory with
relocations applied and imports resolved. MSPaint's IAT entries now point to
real DLL x86 code. Execution enters msvcrt's `_controlfp` and gets stuck on
`FWAIT` (0x9B) + `FSTCW [ebp-4]` (0xD9 0x7D) — x87 FPU opcodes not in decoder.

```
DLL loaded: msvcrt.dll  at 0x0106f000 (SizeOfImage=0x44000)
DLL loaded: mfc42u.dll  at 0x010b3000 (SizeOfImage=0xF2000)
Patched: MSPaint -> MFC42u.DLL (619 ordinal imports resolved)
Patched: MSPaint -> msvcrt.dll (29 imports resolved)
Execution reaches msvcrt x86 code at 0x010735fa
STUCK on: 9b d9 7d fc = FWAIT + FSTCW [EBP-4]
```

**Next:** Add FWAIT (0x9B as NOP) and FSTCW/FLDCW/FNSTCW handlers to decoder.

### Previous: CRT init fails (FIXED)

```
MSPaint.exe CRT Init Flow
==========================

  Entry (0x0104e860)
       |
       v
  __set_app_type -----> OK (fallback stub, returns 0)
  __p__fmode ---------> OK (API #208)
  __p__commode -------> OK (API #209)
  _controlfp ---------> OK (API #211)
  _initterm(b8,bc) ---> STUB (no-op)
       |
       v
  __wgetmainargs -----> MISSING! (fallback returns 0)
  _initterm(1000,10b4)-> STUB (skips CRT init callbacks)
  __p__wcmdln --------> MISSING! (returns 0 -> NULL deref)
       |
       v
  *** CRASH ***         EIP=0, EAX=0xFFFFFFFF

  Even if CRT init is fixed:
  MFC42u ordinal calls -> 619 imports, all unresolved -> crash
```

## Import Analysis

```
DLL                  Imports  Status
---                  -------  ------
msvcrt.dll              29   PARTIAL — missing wide-char variants
KERNEL32.dll            36   PARTIAL — missing W-suffix APIs, MulDiv, etc.
USER32.dll              84   PARTIAL — all W-suffix (Unicode), many missing
GDI32.dll               72   PARTIAL — many new GDI calls needed
MFC42u.DLL             619   NONE — ordinal imports, need actual DLL binary
ADVAPI32.dll             8   PARTIAL — all W-suffix registry APIs
SHELL32.dll              3   NONE
ole32.dll                4   NONE — OLE/COM functions
comdlg32.dll             1   OK
                       ---
TOTAL                  856
```

---

## DLL Loading Plan

### Key Insight

```
The interpreter already executes any x86 at any guest address.
If we load MFC42u.DLL into guest memory and patch MSPaint's IAT
to point to DLL code addresses (not thunks), the interpreter
just runs the DLL's x86 code. No special handling needed.

Call chain:  MSPaint x86 --> MFC42u x86 --> our WASM API stubs

  MSPaint.exe                    MFC42u.DLL
  +-----------+                  +------------+
  | CALL [IAT]|--guest addr----->| x86 code   |
  |           |                  | ...         |
  |           |                  | CALL [IAT]  |--thunk addr--> WASM dispatch
  |           |<--ret------------|             |<--ret--------  (our stubs)
  +-----------+                  +------------+
```

### Address Space Strategy

```
g2w formula: wasm_addr = (guest_addr - image_base) + 0x12000

Load ALL DLLs relative to EXE's image_base. No multi-base needed.
Apply relocations so DLL code uses correct addresses.

Guest memory layout (8MB, plenty of room):
  image_base + 0x000000  MSPaint.exe sections (~340KB)
  image_base + 0x060000  msvcrt.dll  (~300KB, rebased)
  image_base + 0x0B0000  MFC42u.DLL  (~1MB, rebased)
  image_base + 0x1C0000  (other DLLs if needed)
  image_base + 0x???000  heap starts after last DLL
```

---

## Implementation Phases

### Phase 1: Wide String Helpers (`src/parts/10-helpers.wat`)

No dependencies, needed by everything else.

```wat
$guest_wcslen(ptr)              -- count 16-bit units until 0x0000
$guest_wcscpy(dst, src)         -- copy wide string including null
$wide_to_ansi(src, dst, maxlen) -- truncate each wchar to low byte
$ansi_to_wide(src, dst, maxlen) -- zero-extend each byte to 16-bit
```

### Phase 2: Missing API Stubs (`src/parts/09-dispatch.wat`)

Add ~40 new APIs. Update `api_table.json`, run `gen_api_table.js`.

**CRT (msvcrt.dll):**
```
__wgetmainargs    write wide argv (like __getmainargs but 16-bit)
__p__wcmdln       return ptr to L"mspaint\0"
__set_app_type    no-op, pop args, return
free              call $heap_free
malloc            call $heap_alloc
rand              simple LCG (x = x*1103515245 + 12345)
_purecall         exit(3)
_onexit           no-op, return arg
__dllonexit       no-op, return arg
_adjust_fdiv      return ptr to 0
_splitpath        minimal path decomposition
_wcsicmp          wide case-insensitive compare
_wtoi             wide string to int
_itow             int to wide string
wcscmp, wcsncpy   wide string ops
__setusermatherr  no-op
```

**W-suffix Win32 APIs (convert wide->ANSI, delegate to A-suffix):**
```
GetModuleHandleW      -> existing GetModuleHandleA
GetCommandLineW       -> return wide cmdline
CreateWindowExW       -> existing CreateWindowExA
RegisterClassW/ExW    -> existing RegisterClassExA
DefWindowProcW        -> existing DefWindowProcA
LoadCursorW/LoadIconW -> existing A-suffix
MessageBoxW           -> existing MessageBoxA
SetWindowTextW        -> existing SetWindowTextA
SendMessageW          -> existing handler
LoadMenuW             -> existing LoadMenuA
wsprintfW             -> wide sprintf
GetModuleFileNameW    -> stub (return exe path)
GetObjectW            -> existing GetObjectA
CreateFontIndirectW   -> stub
CreateDCW             -> stub
```

**OLE32 minimal stubs:**
```
OleInitialize       -> return S_OK (0)
CoTaskMemFree       -> no-op
StringFromCLSID     -> return E_NOTIMPL
WriteClassStg       -> return E_NOTIMPL
WriteFmtUserTypeStg -> return E_NOTIMPL
```

### Phase 3: _initterm Trampoline (`src/parts/09-dispatch.wat`)

```
_initterm(begin, end) must call each non-null fn ptr in [begin..end).
These are x86 function pointers — need trampoline pattern.

Allocate "initterm-return" thunk (marker 0x1717AAAA, like catch_ret).

Globals: $initterm_ptr, $initterm_end, $initterm_ret

  _initterm handler:
    save return addr -> $initterm_ret
    save begin/end -> globals
    find first non-null fn_ptr in table
    if found: push initterm-thunk, set EIP=fn_ptr, return to run loop
    if none:  return to caller normally

  initterm-thunk handler (when fn_ptr returns):
    advance $initterm_ptr += 4
    find next non-null fn_ptr
    if found: push initterm-thunk, set EIP=fn_ptr, return
    if done:  set EIP=$initterm_ret (back to original caller)
```

### Phase 4: DLL Loader (`src/parts/08b-dll-loader.wat` — NEW FILE)

Core new file, slots between 08-pe-loader.wat and 09-dispatch.wat.

**New globals in `01-header.wat`:**
```
$dll_count (mut i32)         -- loaded DLL count
$DLL_TABLE i32 (0xE63000)   -- metadata: 20 bytes x 16 DLLs
  Per-DLL: {load_addr:4, size_of_image:4, export_dir_rva:4,
            num_functions:4, ordinal_base:4}
$exe_size_of_image (mut i32) -- for computing next load address
```

**`$load_dll(size, load_addr) -> i32` (returns DllMain addr):**
```
1. Validate MZ/PE in PE_STAGING
2. Read preferred ImageBase, compute delta = load_addr - preferred
3. Map sections: memcpy from staging to g2w(load_addr + section_RVA)
4. Process BASE RELOCATIONS:
   - Read reloc directory from PE offset +0xA0
   - Walk reloc blocks: {VirtualAddress:4, SizeOfBlock:4, entries:[u16...]}
   - For each type-3 (HIGHLOW) entry:
     addr = g2w(load_addr + block_VA + (entry & 0xFFF))
     *addr += delta
5. Parse EXPORT TABLE:
   - Read export directory from PE offset +0x78
   - Store: AddressOfFunctions RVA, NumberOfFunctions, OrdinalBase
   - Store in DLL_TABLE entry
6. Process DLL's OWN IMPORTS:
   - Walk import descriptors
   - For system DLLs (KERNEL32 etc): create thunks -> our WASM dispatch
   - For loaded DLLs: resolve via export table
7. Register in DLL_TABLE, increment dll_count
8. Return AddressOfEntryPoint + load_addr (DllMain)
```

**`$resolve_ordinal(dll_idx, ordinal) -> i32`:**
```
Read export AddressOfFunctions array from DLL_TABLE metadata
return load_addr + functions[ordinal - OrdinalBase]
```

**`$resolve_name_export(dll_idx, name_ptr) -> i32`:**
```
Binary search DLL's AddressOfNames table
Get ordinal from AddressOfNameOrdinals
Resolve via AddressOfFunctions
```

**`$patch_caller_imports(caller_import_rva, dll_idx)`:**
```
Walk caller's import descriptor for this DLL
For ordinal imports (bit 31 set): resolve_ordinal, write to IAT
For name imports: resolve_name_export, write to IAT
IAT entries now point to real x86 code in DLL (not thunks)
```

### Phase 5: PE Loader Mods (`src/parts/08-pe-loader.wat`)

```
- Store SizeOfImage in $exe_size_of_image
- In $process_imports, before creating thunks:
  - Read DLL name from import descriptor name RVA
  - If matches loaded DLL -> call $patch_caller_imports
  - If system DLL -> existing thunk creation
- Add ordinal import else-branch (currently empty):
  store ordinal in thunk, dispatch fallback handles it
```

### Phase 6: JS-side (`host/host.js`)

```js
async loadDll(url) {
  const dllBytes = await (await fetch(url)).arrayBuffer();
  const staging = this.instance.exports.get_staging();
  new Uint8Array(this.memory.buffer, staging).set(new Uint8Array(dllBytes));
  const loadAddr = this.instance.exports.get_next_dll_addr();
  return this.instance.exports.load_dll(dllBytes.byteLength, loadAddr);
}

// Modified loadExe for MSPaint:
async loadExe(url) {
  // ... existing EXE loading ...
  // After EXE loaded, check if DLLs needed:
  if (needsDll('MFC42u.DLL')) {
    await this.loadDll('../test/binaries/dlls/msvcrt.dll');
    await this.loadDll('../test/binaries/dlls/MFC42u.DLL');
    // Re-process EXE imports now that DLLs are loaded
    this.instance.exports.resolve_exe_imports();
  }
  // Call DllMain for each DLL
  for (const dll of loadedDlls) {
    this.instance.exports.call_func(dll.dllMain, dll.hInstance, 1, 0, 0);
    this.instance.exports.run(100000); // run DllMain
  }
}
```

### Phase 7: Exports (`src/parts/13-exports.wat`)

```
load_dll(size, load_addr) -> i32
get_next_dll_addr() -> i32
get_exe_size_of_image() -> i32
resolve_exe_imports()  -- re-resolve after DLLs loaded
```

---

## File Summary

```
File                              Action   What
----                              ------   ----
src/parts/01-header.wat           MODIFY   DLL globals, DLL_TABLE, initterm globals
src/parts/08-pe-loader.wat        MODIFY   SizeOfImage, DLL-aware imports, ordinals
src/parts/08b-dll-loader.wat      NEW      DLL loader, relocation, export table
src/parts/09-dispatch.wat         MODIFY   ~40 new API stubs, initterm trampoline
src/parts/10-helpers.wat          MODIFY   Wide string helpers
src/parts/13-exports.wat          MODIFY   Export load_dll, get_next_dll_addr
src/api_table.json                MODIFY   ~40 new API entries
src/parts/01b-api-hashes.wat      REGEN    node tools/gen_api_table.js
tools/gen_api_table.js            MODIFY   Add new APIs to extra list
host/host.js                      MODIFY   loadDll(), DLL orchestration, DllMain
host/index.html                   MODIFY   DLL URLs for mspaint
test/binaries/dlls/               NEW      MFC42u.DLL, msvcrt.dll from Windows
```

## Implementation Order

```
1. Phase 1  Wide string helpers        (no deps)
2. Phase 2  Missing API stubs + regen  (unblocks CRT init)
3. Phase 3  _initterm trampoline       (unblocks CRT callbacks)
4. Phase 4  DLL loader core            (biggest piece)
5. Phase 5  PE loader modifications    (wire DLL loader to EXE loading)
6. Phase 6  JS orchestration           (wire it all together)
7. Phase 7  Exports                    (final wiring)
```

## Verification

```
1. bash tools/build.sh                                    -- compiles?
2. node test/run.js --exe=test/binaries/notepad.exe       -- regression
3. node test/run.js --exe=test/binaries/calc.exe           -- regression
4. node test/run.js --exe=...mspaint.exe --trace-api       -- gets past CRT?
5. Browser: launch MSPaint from host UI                    -- window appears?
```

## DLL Acquisition

Need from a Windows install (`C:\Windows\System32\`):
- `MFC42u.DLL` (~1MB)
- `msvcrt.dll` (~300KB)
Place in `test/binaries/dlls/`

---

## Binary Info

- Path: `test/binaries/entertainment-pack/mspaint.exe`
- Size: 447,248 bytes
- Entry: 0x0104e860
- Resources: 6 menus, 10 dialogs, 271 strings
- Imports: 857 thunks

## API Trace (current crash)

```
#1  __set_app_type(2)
#3  __p__fmode()
#4  __p__commode()
#5  _controlfp(0x10000, 0x30000)
#6  _initterm(0x010010b8, 0x010010bc)
#7  __wgetmainargs(...)         <- MISSING
#9  _initterm(0x01001000, 0x010010b4)
#10 __p__wcmdln()               <- MISSING -> NULL deref -> CRASH
```
