# MSPaint Debugging Notes

## Current Status (2026-04-16)

### Symptom

Runs crash-free into MFC message loop (~1390 API calls during init, then spins
`DefWindowProcA(0,0,0,0)` ~860/batch on WM_NULL). PNG render: solid teal —
class `hbrBackground` via `WM_ERASEBKGND`, no chrome, no toolbar/statusbar, no
canvas. Two windows created:

- `0x10001` — main frame "Paint", `275x400` at CW_USEDEFAULT pos
- `0x10002` — class **"AfxFrameOrView42"** (MFC view), style `WS_VISIBLE|WS_CHILD|WS_CLIPSIBLINGS`, ID `0xE900` (AFX_IDW_PANE_FIRST), size **0×0**

### Root cause: `GetTopWindow` returns 0 → RecalcLayout walks no children

At `09a-handlers.wat:6574`, `GetTopWindow` is a return-0 stub (violates
`feedback_fail_fast_stubs`). Observed in trace during CFrameWnd::RecalcLayout
(runs when WM_SIZE hits the main frame after ShowWindow → GetMessageA drain):

```
BeginDeferWindowPos(8, 0)  → 0xdef00001
GetTopWindow(0x10001)      → 0            ← walk terminates here
EndDeferWindowPos(0xdef00001)
```

With no child returned, MFC never calls `DeferWindowPos` on the view, so the
`AfxFrameOrView42` child stays at 0×0 and is never invalidated. No `BeginPaint`
/`EndPaint`/`InvalidateRect` ever appears in the trace. The teal the user sees
is only the main frame's class background brush.

**Fix applied (this session):**

1. Added z-order-by-slot helpers in `09c-help.wat`: `$wnd_find_first_child`,
   `$wnd_find_last_child`, `$wnd_find_next_sibling`, `$wnd_find_prev_sibling`.
2. `$handle_GetTopWindow` → `$wnd_find_first_child(hwnd)`.
3. `$handle_GetWindow` → full GW_HWNDFIRST/LAST/NEXT/PREV/OWNER/CHILD coverage.
4. `$handle_GetDlgCtrlID` → reads `CONTROL_TABLE[slot]+4` (ctrl_id).
5. CreateWindowExA now stores the hMenu-as-ctrl_id into `CONTROL_TABLE[slot]+4`
   for every child (WS_CHILD + non-null parent), not just the
   detected Edit/Button/Static classes. This lets `GetDlgCtrlID` return the
   pane ID (e.g. 0xE900 AFX_IDW_PANE_FIRST) for real-wndproc children.

**Result (still teal):** RecalcLayout now enumerates correctly:

```
BeginDeferWindowPos(8)              → 0xdef00001
GetTopWindow(0x10001)               → 0x10002    ✓ (was 0)
GetDlgCtrlID(0x10002)               → 0xe900     ✓ (was crash)
GetWindow(0x10002, GW_HWNDNEXT)     → 0          ✓
EndDeferWindowPos
```

But MFC still never calls `DeferWindowPos`/`MoveWindow`/`SetWindowPos` on the
view — the enumeration completes and the view stays at 0×0. Likely the
`RepositionBars(..., AFX_IDW_PANE_FIRST, reposDefault, ...)` second pass is
either short-circuited or we're only seeing its query pass (`reposQuery`). No
`BeginPaint`/`EndPaint`/`InvalidateRect` ever fires.

**Next step:** trace between `EndDeferWindowPos` (API #1204) and the idle
DefWindowProcA spin (~#1400) to find why the pane-reposition pass never issues
a position call. Candidates to inspect: the client rect returned by
`GetClientRect(main, ...)` (must be non-zero for RepositionBars to compute a
pane rect), and whether MFC actually re-enters layout with `reposDefault` vs.
only `reposQuery`.

### Secondary: only view is created, no toolbar/statusbar/palette

Only 2 CreateWindowExA calls observed. MSPaint's `CMainFrame::OnCreate` should
create a toolbar, status bar, tool box, and color palette. The single
AfxFrameOrView42 child strongly suggests we're running `CFrameWnd::OnCreate`
(base, which creates the view via `OnCreateClient`), not the derived
`CMainFrame::OnCreate` — matching the stale 2026-04-03 diagnosis that the
CMainFrame vtable is never installed over the CFrameWnd vtable.

After fixing GetTopWindow, re-check whether the vtable issue still stands — it
may have been fixed incidentally by recent MFC-path changes (MFC did get further
this session: before = 1 window, now = 2; init = 1634 calls, now ~1390).

### Uncommitted changes affecting this

`src/09b-dispatch.wat` (this session): dropped synchronous WM_SIZE during
CreateWindowExA's WM_CREATE chain — WM_SIZE now only arrives via ShowWindow
→ GetMessageA drain of `pending_wm_size`. Confirmed WM_SIZE still reaches the
main frame (RecalcLayout runs). Change did not regress paint.

### Historical notes below (2026-04-03 and earlier, partially stale)

## Previous Status (2026-04-03)

### Three major fixes this session — MFC OnCreate now runs

#### Fix 1: CallWindowProcA implemented

MFC's CWnd::DefWindowProc calls `CallWindowProcA(m_pfnSuper, hwnd, msg, wParam,
lParam)` to forward messages to the superclass WndProc. Two cases:

1. **Thunk target (e.g. DefWindowProcA):** If prevWndFunc is in the thunk zone,
   rewrite the stack inline and dispatch via `$win32_dispatch` directly. Cannot
   set EIP to a thunk because the run loop would infinite-loop (handlers don't
   set EIP, they just adjust ESP/EAX).

2. **Real x86 code target:** Set up a call frame (push 4 WndProc args + return
   address) and set EIP to the prevWndFunc. The WndProc executes normally and
   returns to CallWindowProcA's caller via `ret`.

#### Fix 2: GetClassInfoA implemented (was returning FALSE, causing garbage WndProc)

**Root cause of m_pfnAfxWndProc NULL bug (from previous session):** MFC's
`AfxEndDeferRegisterClass` calls `GetClassInfoA(hInst, "AfxFrameOrView42", &wc)`
to get the base class info, modifies className to "MSPaintApp", then calls
`RegisterClassA(&wc)`. Since GetClassInfoA returned FALSE without filling the
struct, wc contained stack garbage — including a garbage lpfnWndProc (0x02bffbb0,
a stack address). This was stored in the class table and later returned by
`SetWindowLongA(GWL_WNDPROC)` as `m_pfnSuper`.

**Fix:** GetClassInfoA now looks up the class in the class table and copies the
saved WNDCLASS struct (40 bytes) to the output buffer. RegisterClassA and
RegisterClassExA now save the full WNDCLASS at `0x2300 + slot*40`.

New helper: `$class_find_slot` — returns class table slot index (0-15) by name
hash, or -1 if not found.

#### Fix 3: Window style tracking (GWL_STYLE)

Added `$wnd_get_style` / `$wnd_set_style` using style table at WASM 0x2580
(32 slots × 4 bytes). CreateWindowExA stores the style; GetWindowLongA(-16) and
SetWindowLongA(-16) read/write it. Also added GWL_EXSTYLE(-20) returning 0.

### VirtualAlloc alignment fix (RESOLVED)

**Root cause:** VirtualAlloc(NULL, size) called heap_alloc() which returned
non-page-aligned addresses. msvcrt's Small Block Heap (SBH) expected
page-aligned VirtualAlloc returns → corrupt sub-allocation → odd malloc
pointers (0x0184f279).

**Fix:** VirtualAlloc now page-aligns heap_ptr before bump-allocating;
VirtualFree returns TRUE. malloc now returns 4-byte aligned pointers
(e.g. 0x0158a01c).

### Vtable still wrong (ONGOING)

- `[this]` = 0x010f2c24 (CFrameWnd vtable in MFC42), expected CMainFrame vtable in EXE
- Only ONE vtable write observed — CMainFrame constructor body never executes its vtable assignment
- EXE has 5 vtable write sites (0x1002064, 0x1006174, 0x10065a4, 0x100666c, 0x1006cdc) — NONE hit
- Need to trace constructor call chain to find where execution diverges

### Current blocker: vtable / CMainFrame::OnCreate never runs

MSPaint now runs crash-free through initialization and into the MFC message
loop (1634 API calls, idle in GetMessageA). But only 1 CreateWindowExA call
(the main frame) — no child windows (toolbar, statusbar, canvas).

The vtable issue from before VirtualAlloc fix persists: `[this]` = 0x010f2c24
(CFrameWnd vtable in MFC42), should be CMainFrame vtable in EXE. None of
the EXE's 5 vtable write sites are hit. CMainFrame::OnCreate never executes,
so no child windows are created. Window title IS set to "Paint" and
DragAcceptFiles is called — some MFC init works, but OnCreate is skipped.

**Next step:** Trace the CMainFrame constructor call chain. The constructor
allocates via malloc (now aligned), writes CFrameWnd vtable, but never
overwrites with CMainFrame vtable. Need to find where the EXE's constructor
body diverges — likely a failed conditional or missing API return.

### Fixes this sub-session

- **VirtualAlloc alignment** — page-aligns heap_ptr before bump-allocating;
  VirtualFree returns TRUE. msvcrt SBH no longer corrupts malloc pointers.
- **IsWindowVisible** — returns normalized BOOL (0/1), was returning raw
  WS_VISIBLE bit (0x10000000)
- **SetWindowPlacement** — reads rcNormalPosition from WINDOWPLACEMENT struct,
  calls host_move_window, returns TRUE (2 args stdcall)
- **GetWindowPlacement** — fills WINDOWPLACEMENT with SW_SHOWNORMAL defaults
  and 640×480 rect (2 args stdcall)
- **BeginDeferWindowPos/EndDeferWindowPos/GetTopWindow** — implemented
- **GetLastActivePopup** — returns hWnd (no popups tracked, per Win32 docs)
- **BringWindowToTop/SetForegroundWindow** — return TRUE (single-window model)
- **AdjustWindowRectEx** — same chrome offsets as AdjustWindowRect, 4 args
- **GetWindow** — returns NULL for siblings/children, parent for GW_OWNER

### Previous Status (2026-04-02)

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
- Memory layout expanded to 64MB (1024 pages) for larger DLL address space
- mfc42.dll DllMain now recognized as successful (was misdetected as crash)
- RegSetValueA/W restored to no-op stubs (registry writes during file
  association setup are harmless)
- PeekMessageA now delivers pending WM_CREATE/WM_SIZE (MFC uses Peek not Get)
- `_mbsnbcmp` implemented (multibyte n-byte compare, ASCII memcmp)
- `GetVolumeInformationA` implemented (fake FAT volume info)
- `SHGetFileInfoA` implemented (returns 0 = no shell info)
- PeekMessageA now delivers phase messages (WM_ACTIVATE, WM_ERASEBKGND, WM_PAINT)
  and checks `paint_pending` / `child_paint_hwnd` — same as GetMessageA
- EXE reaches 91K+ API calls, creates window, renders teal background
  (was 0 → 3 → 9 → 10 → 103 → 1229 → 806 → 91K)
- PNG render works — shows solid teal window background

### Previous: Window renders but no UI elements — two fixes applied, root cause found

MSPaint creates main window, enters MFC message loop. Window renders as solid
teal background — no toolbar, statusbar, canvas, or menu visible.

#### Fix 1: Complete CREATESTRUCT (committed f7bc8a5)

The synchronous WM_CREATE dispatch built a CREATESTRUCT at 0x400100 with only
3 of 12 fields. Now fills all 12 fields from CreateWindowExA stack args BEFORE
cleaning the frame (since cleanup destroys the stack args).

#### Fix 2: CBT hook dispatch (committed f7bc8a5)

MFC installs a WH_CBT(5) hook via SetWindowsHookExA (API #1260, hookproc at
0x0105678f) BEFORE calling CreateWindowExA. The hook's HCBT_CREATEWND handler
associates the CWnd* C++ object with the hwnd and calls SetWindowLongA to
subclass the window with MFC's AfxWndProc.

Previously SetWindowsHookExA was a no-op stub → hook never fired → CWnd never
associated → MFC's WndProc couldn't find the CWnd for hwnd → forwarded
WM_CREATE straight to DefWindowProcA without processing.

**Changes made:**
- New global `$cbt_hook_proc` — stores CBT hook proc address
- SetWindowsHookExA now saves hook proc when idHook==WH_CBT(5)
- CreateWindowExA calls CBT hook with HCBT_CREATEWND before WM_CREATE
- New continuation thunk (0xCACA0002) chains CBT hook → WM_CREATE dispatch
- CBT_CREATEWND struct at 0x400140 = { &CREATESTRUCT, HWND_TOP }
- CallNextHookEx implemented (returns 0, no next hook in chain)

**Trace with fix:** CBT hook now executes (API #1262-1273), allocates CWnd
data (malloc), calls GetParent, and calls SetWindowLongA(hwnd, GWL_WNDPROC).

#### Remaining blocker: m_pfnAfxWndProc is NULL

MFC's CBT hook calls SetWindowLongA(0x10001, GWL_WNDPROC(-4), **0x00000000**)
— the new WndProc is NULL. The hook reads m_pfnAfxWndProc from the MFC module
state struct at offset +0x103c. This field is never initialized.

**Root cause: `_initterm` doesn't iterate function pointers.**

The init function at 0x0105c8ef IS in the table range 0x0111d000-0x0111d100
(confirmed: file offset 0xc5a40 → .data RVA 0xc8040 → guest 0x0111d040,
value 0x5f4078e5 → after relocation 0x0105c8e5). MFC42's DllMain calls
`_initterm(0x0111d000, 0x0111d100)` which SHOULD iterate this table.

**Two `_initterm` flows exist:**
1. **MFC42 DllMain** → calls through patched IAT → real msvcrt `_initterm`
   code runs natively in emulator. DllMain completes cleanly (EAX=1), but
   breakpoint at 0x0105c8e5 never triggers → init functions NOT called.
   Either relocations aren't applied to .data init table entries, or real
   msvcrt's `_initterm` is not iterating correctly.
2. **EXE CRT startup** (API #27) → goes through thunk → our handler.
   Previously was a no-op stub. Now implemented with continuation thunks.

**Dispatch restructure (committed 5402e4b):** Split into two files:
- `09b-dispatch.wat` (hand-written) — thunk handlers (CACA0000-0004), arg
  loading, calls $dispatch_api_table
- `09b2-dispatch-table.generated.wat` — just the br_table, generated by
  gen_dispatch.js. No hand-written logic embedded in JS strings.

**_initterm implemented (committed 5402e4b):** Handler iterates [start, end)
function pointer table, calls each non-NULL entry via 0xCACA0003 continuation
thunk chain. Replaces the previous no-op stub.

**DLL-to-DLL import patching (committed 2a2f621):** MFC42's IAT for MSVCRT
imports was never resolved — only EXE imports were patched. Added
`patchDllImports()` in dll-loader.js. With this fix:
- MFC42 DllMain → real msvcrt `_initterm` → CRT init table → constructor at
  0x0105c8ef → sets m_pfnAfxWndProc = AfxWndProc (0x0105719d)
- CBT hook sets WndProc to AfxWndProc (was NULL before)
- WM_CREATE reaches MFC's CFrameWnd::OnCreate
- Relocations confirmed correct (guest 0x0111d040 = 0x0105c8e5)

#### Previous blocker: CallWindowProcA not implemented — RESOLVED (2026-04-03)

MFC's OnCreate calls `CallWindowProcA` (API #1352) to forward WM_CREATE to
the previous WndProc. Implemented with two paths: inline dispatch for thunk
targets, EIP-jump for real x86 code. See "Fix 1" in 2026-04-03 status.

### Key fix: PeekMessageA pending message delivery (2026-04-02)

MFC's message pump uses `PeekMessageA`, not `GetMessageA`. But only
`GetMessageA` checked `pending_wm_create`/`pending_wm_size` flags. This meant
MFC's main window never received WM_CREATE or WM_SIZE — it sat in an idle
loop calling `DefWindowProcA(0,0,0,0)` ~1000×/batch. Fixed by adding the same
pending message checks to `PeekMessageA` (with PM_REMOVE flag handling).

### Previous: GetParent returned garbage — partially resolved

`GetParent(0x10001)` returned 0xf0 instead of 0 for top-level window.
Root cause unclear — parent table slot may have stale data. After the
PeekMessageA fix, execution takes a different path and this may no longer
be hit. The GetParent implementation is correct; the data flow needs
verification if this resurfaces.

WASM low-memory window tables:
```
0x2000  Window table     32 × 8B   [hwnd, wndproc]
0x2100  Class table      16 × 12B  [name_hash, wndproc, extra_bytes]
0x2200  GWL_USERDATA     32 × 4B   [userdata per slot]
0x2280  Parent table     32 × 4B   [parent_hwnd per slot]
0x2300  (free)
```

All window infra lives in `09c-help.wat` (misleading name — it's the window
table + class table + userdata + parent system; help dialog is appended at end).

### Previous Blocker: mfc42 DllMain false crash — RESOLVED (2026-04-02)

mfc42's DllMain was misdetected as crashing. Actually, it returned successfully
(EAX=1) but the sentinel return address (0) caused the emulator to try executing
at address 0 → `memory access out of bounds`. Fixed in `callDllMain`: detect
EIP≤2 + EAX=1 as successful return rather than a real crash. Relocations were
verified correct (e.g. `mov ecx,[0x5f4cbc50]` properly relocated to `[0x1120c50]`).

### Previous Blocker: use-after-free in MFC window management (batch 10) — SUPERSEDED

At batch 10 (with old 32MB layout), crash on vtable call through freed memory.
Root cause was `GetDlgItem` returning NULL, causing MFC to destroy frame object
while still in use. No longer the active blocker — MFC init now proceeds past
this point. The underlying issue (no window handle tracking for
`GetDlgItem`/`GetTopWindow`) remains unresolved but is not the immediate problem.

### Silent stubs converted to crash-on-unimplemented (2026-04-02)

Converted 14 silent return-0 stubs that violated the fail-fast rule. These hid
bugs by pretending to succeed without doing real work.

**Wave 1 (safe — not hit by notepad/calc/skifree):**
`wsprintfW`, `FindWindowA`, `GetDlgItem`, `GetTopWindow`, `GetActiveWindow`,
`EnableMenuItem`, `CheckMenuItem`

**Wave 2 (notepad-affecting — breaks notepad until implemented):**
`SendMessageA`, `SetFocus`, `SHGetSpecialFolderPathA`, `IsIconic`, `WinHelpA`
Notepad now crashes on `SendMessageA` at startup.

**Sub-dispatcher fallbacks:** `dispatch_local`, `dispatch_global`, `dispatch_lstr`,
`dispatch_reg` — unmatched API names now crash instead of silently returning 0.

**Left as-is (legitimate minimal implementations):** `SetCursor`, `OleInitialize`,
`RegQueryValueA`, `SetUnhandledExceptionFilter`, `LoadCursorA`, `LoadIconA`,
critical sections, thread IDs, code pages, `SetWindowsHookExA/W`,
`GetLayout`/`SetLayout`.

**Impact on MSPaint:** `GetDlgItem` and `GetTopWindow` (previously returning NULL)
now crash. This makes the batch 10 use-after-free blocker explicit — the app will
crash on `GetDlgItem` instead of silently getting NULL and corrupting memory later.

### Memory layout expanded to 64MB (2026-04-02)

Memory expanded from 512 pages (32MB) to 1024 pages (64MB) to accommodate
larger DLL address spaces. Guest address space grew from 14MB to 28MB.
Both `test/run.js` and `host/host.js` updated to match. All region bases
shifted: stack at 0x01C12000, thunk zone at 0x01D12000, thread cache at
0x01D52000, DLL table at 0x02066000. Changes are uncommitted.

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
- GetClassInfoA — return FALSE (class not found), 3 args stdcall
- GetActiveWindow — return NULL, 0 args
- GetDlgItem — return NULL, 2 args stdcall
- GetTopWindow — return NULL, 1 arg stdcall

### Tools added/improved this session

- `tools/pe-imports.js` — list PE import descriptors and entries (`--dll=name`, `--all`)
- `tools/pe-sections.js` — show PE section layout with `--base=0xLOADADDR`
- `tools/hexdump.js` — added `--base=0xLOADADDR` for relocated DLL analysis
- `tools/check-hash-table.js` — verify API hash table integrity (WAT vs JSON)
- `gen_dispatch.js` — now emits `$host_log` call, enabling `--trace-api` / `--break-api`
  (was completely broken before — no API calls were logged through thunk dispatch)

### Key debugging insight: hash table corruption

mfc42's DllMain runs `rep stosd` with uninitialized EDI (wild pointer → guest
0x02350000). `$gs32` converts via `g2w` to WASM 0x01362000 which was the hash
table. The entire 6KB hash table was zeroed. All runtime `$lookup_api_id` calls
returned 0xFFFF. Fix: relocate hash table to WASM 0x4000 (below GUEST_BASE,
unreachable by any `g2w` of a valid guest address).

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

### Memory Layout (64MB, updated 2026-04-02)

- MSPaint image_base: 0x01000000
- mfc42.dll loaded at: 0x01055000
- msvcrt.dll loaded at: 0x01142000
- Guest stack: 0x02C00000 (ESP starts at top of 1MB region at 0x01C12000 WASM)
- Thunk zone: 0x02D00000+ (1554 thunks after DLL loading)
- WASM regions: guest 0x00012000 (28MB), stack 0x01C12000, heap 0x01D12000,
  thunks 0x01D12000, thread cache 0x01D52000, DLL table 0x02066000
